import {createHash} from "node:crypto";

const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Source gating is shared by the fake SMS and Telegram channels. A notification
// is never sent solely because a historical intent row exists in SQLite.
export function notificationSourceValidity(db,intent,now){
  if(intent.state!=="pending")return "COALESCED";
  const schema=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  if(intent.source_kind==="blocker"){
    if(!schema.get("ci_blockers"))return "SOURCE_TABLE_UNAVAILABLE";
    const existing=db.prepare(`SELECT state FROM ci_blockers
      WHERE workstream_id=? AND blocker_key=?`).get(intent.workstream_id,intent.source_key);
    const latest=db.prepare(`SELECT MAX(source_revision) AS rev
      FROM notification_intents WHERE source_kind='blocker' AND source_key=?`)
      .get(intent.source_key).rev;
    return existing?.state==="open"&&latest===intent.source_revision?
      "VALID":"SOURCE_RESOLVED_OR_REPLACED";
  }
  if(intent.source_kind==="approval"){
    if(!schema.get("operator_requests"))return "SOURCE_TABLE_UNAVAILABLE";
    const request=db.prepare(`SELECT state,revision,expires_at FROM operator_requests
      WHERE id=? AND workstream_id=?`)
      .get(intent.source_key,intent.workstream_id);
    return request&&["pending","held"].includes(request.state)&&
      request.revision===intent.source_revision&&now<request.expires_at?
      "VALID":"APPROVAL_NOT_CURRENT";
  }
  if(intent.source_kind==="pause"){
    if(!schema.get("ci_pause_episodes"))return "SOURCE_TABLE_UNAVAILABLE";
    const episode=db.prepare(`SELECT episode,active FROM ci_pause_episodes
      WHERE workstream_id=?`).get(intent.workstream_id);
    return episode?.active===1&&digest([intent.workstream_id,
      "ci-supervision-stop",episode.episode])===intent.source_key?
      "VALID":"PAUSE_NOT_CURRENT";
  }
  return "UNSUPPORTED_SOURCE";
}
