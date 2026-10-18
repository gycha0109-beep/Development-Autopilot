import {createHmac,randomBytes,timingSafeEqual} from "node:crypto";

// Only a local fake. No network, Telegram token, real sender enrollment or cost.
export class FakeMessenger {
  #key=randomBytes(32);
  constructor({outcome="sent"}={}){this.kind="fake";this.outcome=outcome;this.messages=[];}
  async deliver(message){this.messages.push({...message});return {deliveryId:message.deliveryId,status:this.outcome};}
  sign(senderId,body){
    const payload=JSON.stringify({senderId,body});
    return {payload,signature:createHmac("sha256",this.#key).update(payload).digest("hex")};
  }
  async authenticate(envelope){
    if(typeof envelope?.payload!=="string"||envelope.payload.length>8192||!/^[a-f0-9]{64}$/.test(envelope.signature||""))return null;
    const expected=createHmac("sha256",this.#key).update(envelope.payload).digest();
    if(!timingSafeEqual(expected,Buffer.from(envelope.signature,"hex")))return null;
    return JSON.parse(envelope.payload);
  }
}
