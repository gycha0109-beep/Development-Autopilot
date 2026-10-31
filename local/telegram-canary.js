// One explicitly requested private-chat canary. Never called by the server.
// Usage (after local credential enrollment): node local/telegram-canary.js --send-canary
import {TelegramBotTransport} from "./telegram-bot-transport.js";

if(process.argv.length!==3||process.argv[2]!=="--send-canary"||
   process.env.AUTOPILOT_TELEGRAM_ENABLED!=="1"){
  console.error("TELEGRAM_CANARY_REQUIRES_EXPLICIT_SEND_AND_OPT_IN");
  process.exitCode=2;
}else{
  try{
    const transport=new TelegramBotTransport();
    const credential=await transport.ready();
    const result=await transport.send({
      workstreamName:"Development Autopilot",
      sourceKind:"test",severity:"normal",reasonCode:"TELEGRAM_SETUP_TEST"
    },credential);
    if(result.status==="accepted"){
      console.log("TELEGRAM_CANARY_ACCEPTED_BY_API");
    }else if(result.status==="permanent_failure"){
      console.log("TELEGRAM_CANARY_REJECTED_CHECK_BOT_AND_START");
      process.exitCode=2;
    }else{
      console.log("TELEGRAM_CANARY_UNCERTAIN_NO_AUTO_RETRY");
      process.exitCode=2;
    }
  }catch{
    console.error("TELEGRAM_CANARY_NOT_CONFIGURED");
    process.exitCode=2;
  }
}
