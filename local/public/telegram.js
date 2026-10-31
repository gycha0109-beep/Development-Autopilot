const el=id=>document.getElementById(id);
const errors={
  TELEGRAM_BOT_TOKEN_INVALID:"봇 토큰 형식이 올바르지 않습니다.",
  TELEGRAM_UNEXPECTED_BOT_USERNAME:"입력한 토큰이 @Johnny0109bot의 토큰이 아닙니다.",
  TELEGRAM_CHAT_ID_INVALID:"수신 Chat ID는 숫자만 입력해야 합니다.",
  TELEGRAM_RECIPIENT_NOT_FOUND_SEND_START:"봇과의 개인 대화 기록을 찾지 못했습니다. Telegram에서 봇에 /start를 보낸 후 재시도하세요. 기존 업데이트를 이미 소비했다면 Chat ID를 직접 입력하세요.",
  TELEGRAM_MULTIPLE_RECIPIENTS_ENTER_CHAT_ID:"봇에 연결된 개인 대화가 여러 개입니다. 수신할 개인 Chat ID를 직접 입력하세요.",
  TELEGRAM_CREDENTIAL_PROTECTION_FAILED:"Windows 사용자 계정 암호화에 실패했습니다. 현재 PC 계정에서 실행 중인지 확인하세요.",
  TELEGRAM_PROVIDER_UNREACHABLE:"Telegram 서버 연결이 되지 않습니다. 인터넷과 방화벽을 확인하세요."
};
function message(text,error=false){
  el("result").textContent=text;
  el("result").className=error?"error":"success";
}
async function refresh(){
  const r=await fetch("/api/v1/snapshot",{cache:"no-store"});
  if(!r.ok)throw Error("로컬 서버 상태를 조회할 수 없습니다.");
  const s=await r.json();
  const c=s.telegramConnection;
  if(c?.configured){
    el("status").textContent="연결됨 · @"+c.botUsername;
    el("status").className="connected";
    el("status-detail").textContent="수신 Chat ID 끝자리: "+c.chatIdSuffix+
      " · 마지막 설정: "+new Date(c.encryptedAt).toLocaleString("ko-KR");
  }else{
    el("status").textContent="연결되지 않음";
    el("status").className="disconnected";
    el("status-detail").textContent="봇 토큰과 개인 Chat ID를 설정하면 승인 알림이 활성화됩니다.";
  }
  el("disconnect").disabled=!c?.configured;
}
el("telegram-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const token=el("token").value.trim();
  const chatId=el("chat-id").value.trim();
  el("connect").disabled=true;
  message("Telegram 봇과 수신자를 검증하고 테스트 알림을 보내는 중입니다.");
  try{
    const r=await fetch("/api/v1/telegram/configure",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({botToken:token,chatId:chatId||undefined})
    });
    const result=await r.json();
    if(!r.ok)throw Error(errors[result.error]||(
      /^TELEGRAM_PROVIDER_HTTP_/.test(result.error||"")?
        "Telegram API가 요청을 거부했습니다: "+result.error:
        "봇 연결을 확인하지 못했습니다."
    ));
    el("token").value="";
    el("chat-id").value="";
    await refresh();
    message("연결 성공! 텔레그램에 테스트 메시지를 전송했습니다. 수신 기록을 확인하세요.");
  }catch(error){message(error.message,true);}
  finally{el("connect").disabled=false;}
});
el("disconnect").addEventListener("click",async()=>{
  if(!confirm("텔레그램 알림 연결을 해제하시겠습니까?"))return;
  const r=await fetch("/api/v1/telegram/disconnect",{
    method:"POST",headers:{"Content-Type":"application/json"},body:"{}"
  });
  if(r.ok){await refresh();message("텔레그램 알림 연결을 해제했습니다.");}
  else message("연결 해제에 실패했습니다.",true);
});
refresh().catch(e=>message(e.message,true));
