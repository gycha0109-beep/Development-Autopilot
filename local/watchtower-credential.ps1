# Windows Credential Manager reader for the *dedicated* Watchtower bridge token.
# Never echo a token to logs; stdout is exclusively read by the parent Node process.
# keyring-rs windows-native maps Entry::new(service,user) to "user.service".
$ErrorActionPreference = "Stop"
$native = @'
using System;
using System.Runtime.InteropServices;
public static class AutopilotWinCred {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public Int64 LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 reserved, out IntPtr credential);
    [DllImport("Advapi32.dll", EntryPoint="CredFree", SetLastError=true)]
    private static extern void CredFree(IntPtr credential);
    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target,1,0,out ptr)) throw new InvalidOperationException("Credential unavailable");
        try {
            CREDENTIAL credential = (CREDENTIAL) Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (credential.CredentialBlob == IntPtr.Zero ||
                credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > 4096)
                throw new InvalidOperationException("Invalid credential");
            byte[] raw = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob,raw,0,raw.Length);
            return System.Text.Encoding.UTF8.GetString(raw);
        } finally {
            CredFree(ptr);
        }
    }
}
'@
try {
    Add-Type -TypeDefinition $native -ErrorAction Stop
    # Exact service/user mapping from keyring-rs on Windows. This is NOT the GitHub PAT.
    $token = [AutopilotWinCred]::Read("development-autopilot-bridge-v1.ci-watchtower")
    if (-not ($token -match '^[A-Za-z0-9_-]{32,256}$')) {
        throw "Invalid token format"
    }
    [Console]::Out.Write($token)
    exit 0
} catch {
    # Deliberately avoid printing API details, tokens or Windows credential contents.
    [Console]::Error.WriteLine("WATCHTOWER_CREDENTIAL_UNAVAILABLE")
    exit 1
}
