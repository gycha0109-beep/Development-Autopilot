// Deterministic SMS-02 transport for isolated tests. NEVER opens a socket.
// Does not accept phone numbers, credentials or real message bodies.
import {createHmac,randomBytes,timingSafeEqual} from "node:crypto";

const ID=/^[a-f0-9]{64}$/;
export class FakeSmsProvider {
  #key=randomBytes(32);
  constructor({outcomes=["accepted"]}={}){
    if(!Array.isArray(outcomes)||!outcomes.length)throw Error("INVALID_FAKE_SMS_OUTCOMES");
    this.kind="fake-sms";
    this.outcomes=[...outcomes];
    this.calls=[];
    this.received=new Map();
    this.messages=new Map();
    this.next=0;
  }
  async send(input){
    if(!ID.test(input?.intentId||"")||!ID.test(input?.deliveryKey||"")||
       !["blocker","approval","pause"].includes(input?.sourceKind)||
       !/^[A-Z][A-Z0-9_]{1,99}$/.test(input?.reasonCode||""))
      throw Error("INVALID_FAKE_SMS_PAYLOAD");
    const {intentId,deliveryKey,sourceKind,severity,reasonCode}=input;
    this.calls.push({intentId,deliveryKey,sourceKind,severity,reasonCode});
    if(this.received.has(deliveryKey))
      return {...this.received.get(deliveryKey)};
    const outcome=this.outcomes[Math.min(this.next++,this.outcomes.length-1)];
    if(outcome==="timeout")throw Error("FAKE_TRANSPORT_TIMEOUT");
    if(outcome==="crash_after_accept"){
      const accepted={status:"accepted",providerMessageId:"fake-"+deliveryKey.slice(0,22)};
      this.received.set(deliveryKey,accepted);
      this.messages.set(accepted.providerMessageId,deliveryKey);
      throw Error("FAKE_RESULT_LOST_AFTER_PROVIDER_ACCEPT");
    }
    if(!["accepted","not_sent","permanent_failure"].includes(outcome))
      throw Error("INVALID_FAKE_SMS_OUTCOME");
    if(outcome!=="accepted")return {status:outcome};
    const accepted={status:"accepted",providerMessageId:"fake-"+deliveryKey.slice(0,22)};
    this.received.set(deliveryKey,accepted);
    this.messages.set(accepted.providerMessageId,deliveryKey);
    return {...accepted};
  }
  receipt(providerMessageId,{eventId=null}={}){
    const deliveryKey=this.messages.get(providerMessageId);
    if(!deliveryKey)throw Error("UNKNOWN_FAKE_SMS_MESSAGE");
    const chosenEventId=eventId||"evt-"+randomBytes(12).toString("hex");
    const data={eventId:chosenEventId,deliveryKey,providerMessageId};
    return {...data,signature:createHmac("sha256",this.#key)
      .update(JSON.stringify(data)).digest("hex")};
  }
  verifyReceipt(receipt){
    if(typeof receipt?.eventId!=="string"||
       !/^evt-[A-Za-z0-9_-]{1,80}$/.test(receipt.eventId)||
       !ID.test(receipt.deliveryKey||"")||
       typeof receipt.providerMessageId!=="string"||
       !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.providerMessageId)||
       typeof receipt.signature!=="string"||
       !/^[a-f0-9]{64}$/.test(receipt.signature))return false;
    if(this.messages.get(receipt.providerMessageId)!==receipt.deliveryKey)return false;
    const data={eventId:receipt.eventId,deliveryKey:receipt.deliveryKey,
      providerMessageId:receipt.providerMessageId};
    const want=createHmac("sha256",this.#key).update(JSON.stringify(data)).digest();
    return timingSafeEqual(want,Buffer.from(receipt.signature,"hex"));
  }
}
