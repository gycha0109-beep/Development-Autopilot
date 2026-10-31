// Only these exact ChatGPT routes are eligible for explicitly approved sends.
// Project landing is restricted to g-p- project IDs, never custom GPT landing
// pages or settings/search/account pages.
export function classifyChatGPTRoute(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== "https://chatgpt.com" || parsed.username || parsed.password)
    return null;
  const path = parsed.pathname;
  if (/^\/c\/[^/]+\/?$/.test(path) ||
      /^\/g\/[^/]+\/c\/[^/]+\/?$/.test(path))
    return "existing";
  if (path === "/") return "new";
  if (/^\/g\/g-p-[^/]+(?:\/project)?\/?$/.test(path))
    return "project-new";
  return null;
}

// Only the conversation created from a registered empty landing page can be
// offered for explicit same-tab rebinding. Existing-chat navigation is excluded.
export function isCreatedChatRoute(before,after) {
  let a,b;
  try { a=new URL(before);b=new URL(after); } catch { return false; }
  if([a,b].some(u=>u.origin!=="https://chatgpt.com"||u.search||u.hash||u.username||u.password))return false;
  if(a.pathname==="/")return /^\/c\/[^/]+\/?$/.test(b.pathname);
  const project=a.pathname.match(/^\/g\/(g-p-[^/]+)(?:\/project)?\/?$/)?.[1];
  return !!project&&b.pathname.startsWith("/g/"+project+"/c/")&&classifyChatGPTRoute(b.href)==="existing";
}

// Epoch recovery may keep an already confirmed conversation, but must never
// treat navigation to another chat (or a query/hash variant) as the same chat.
export function isSameExistingChatRoute(before,after) {
  let a,b;
  try { a=new URL(before);b=new URL(after); } catch { return false; }
  return before===after&&a.href===b.href&&
    [a,b].every(u=>u.origin==="https://chatgpt.com"&&!u.search&&!u.hash&&!u.username&&!u.password)&&
    classifyChatGPTRoute(a.href)==="existing";
}
