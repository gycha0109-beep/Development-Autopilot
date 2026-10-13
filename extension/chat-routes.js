// Only the exact ChatGPT routes below are eligible for explicitly approved
// sends. Project landing is restricted to g-p- project IDs, never arbitrary
// custom GPT landing pages or search/settings/account pages.
export function classifyChatGPTRoute(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== "https://chatgpt.com" || parsed.username || parsed.password)
    return null;
  const path = parsed.pathname;
  if (/^\\/c\\/[^/]+\\/?$/.test(path) ||
      /^\\/g\\/[^/]+\\/c\\/[^/]+\\/?$/.test(path))
    return "existing";
  if (path === "/") return "new";
  if (/^\\/g\\/g-p-[^/]+(?:\\/project)?\\/?$/.test(path))
    return "project-new";
  return null;
}
