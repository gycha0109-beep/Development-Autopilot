const stats = document.getElementById("popup-stats");
const button = document.getElementById("open-dashboard");

button.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "AP_GET" });
    if (!response?.ok) throw new Error(response?.error || "상태를 불러올 수 없습니다.");
    const { overview } = response.data;
    stats.replaceChildren();
    const counts = [
      ["감지된 그룹", overview.discoveredGroups],
      ["등록된 탭", overview.registeredTabs],
      ["활성 연결", overview.activeTabs],
      ["확인 필요", overview.attention]
    ];
    for (const [label, value] of counts) {
      const card = document.createElement("div");
      card.className = "popup-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = label;
      card.append(strong, caption);
      stats.append(card);
    }
  } catch (error) {
    stats.textContent = "상태 조회 실패: " + error.message;
  }
}
void init();
