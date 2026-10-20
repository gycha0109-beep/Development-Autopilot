# Windows Credential Manager reader for the *dedicated* Watchtower bridge token.
# Never echo a token to logs; stdout is exclusively read by the parent Node process.
# keyring-rs windows-native maps Entry::new(service,user) to "user.service".
param([switch]$SelfTest)
$ErrorActionPreference = "Stop"
$native = @'
using System;
using System.Runtime.InteropServices;
public static class AutopilotWinCred {
    [StructLayout(LayoutKind.Sequential)]
    public struct CREDENTIAL {
        public UInt32 Flags;
        public UInt32 Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public Int64 LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }
    [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 reserved, out IntPtr credential);
    [DllImport("Advapi32.dll", EntryPoint="CredFree", SetLastError=true)]
    private static extern void CredFree(IntPtr credential);
    public static string DecodePassword(byte[] raw) {
        // keyring 3 set_password uses UTF-16LE: 64 hex characters = 128 bytes.
        if (raw == null || raw.Length != 128)
            throw new InvalidOperationException("Invalid credential");
        string token = System.Text.Encoding.Unicode.GetString(raw);
        if (!System.Text.RegularExpressions.Regex.IsMatch(token, @"\A[0-9a-fA-F]{64}\z"))
            throw new InvalidOperationException("Invalid credential");
        return token;
    }
    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target,1,0,out ptr)) throw new InvalidOperationException("Credential unavailable");
        try {
            CREDENTIAL credential = (CREDENTIAL) Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (credential.CredentialBlob == IntPtr.Zero ||
                credential.CredentialBlobSize != 128)
                throw new InvalidOperationException("Invalid credential");
            byte[] raw = new byte[credential.CredentialBlobSize];
            try {
                Marshal.Copy(credential.CredentialBlob,raw,0,raw.Length);
                return DecodePassword(raw);
            } finally { Array.Clear(raw,0,raw.Length); }
        } finally {
            CredFree(ptr);
        }
    }
}
'@
try {
    Add-Type -TypeDefinition $native -ErrorAction Stop
    if ($SelfTest) {
        # Synthetic decoding only: no Credential Manager or HTTP access.
        $sample = '0123456789abcdef' * 4
        $valid = [System.Text.Encoding]::Unicode.GetBytes($sample)
        try {
            if ([AutopilotWinCred]::DecodePassword($valid) -cne $sample) { throw 'Decode failed' }
            foreach ($invalid in @(
                [System.Text.Encoding]::UTF8.GetBytes($sample),
                [System.Text.Encoding]::Unicode.GetBytes(('g' * 64)),
                [System.Text.Encoding]::Unicode.GetBytes(($sample + '0'))
            )) {
                $rejected = $false
                try { [AutopilotWinCred]::DecodePassword($invalid) | Out-Null }
                catch { $rejected = $true }
                if (-not $rejected) { throw 'Malformed credential accepted' }
            }
        } finally { [System.Array]::Clear($valid,0,$valid.Length) }
        [Console]::Out.Write('WATCHTOWER_CREDENTIAL_SELF_TEST_PASSED')
        exit 0
    }
    # Exact service/user mapping from keyring-rs on Windows. This is NOT the GitHub PAT.
    $token = [AutopilotWinCred]::Read("development-autopilot-bridge-v1.ci-watchtower")
    if (-not ($token -cmatch '^[0-9a-fA-F]{64}$')) {
        throw "Invalid token format"
    }
    [Console]::Out.Write($token)
    exit 0
} catch {
    # Deliberately avoid printing API details, tokens or Windows credential contents.
    [Console]::Error.WriteLine("WATCHTOWER_CREDENTIAL_UNAVAILABLE")
    exit 1
}
