const q = (s) => document.querySelector(s);
const listEl = q('#list');
const statusEl = q('#status');

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  return await chrome.tabs.sendMessage(tab.id, message);
}

function renderList(items) {
  listEl.innerHTML = '';
  if (!items || items.length === 0) {
    listEl.innerHTML = '<li class="empty">No matches yet.</li>';
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `
      <a href="${it.url}" target="_blank" rel="noreferrer">Open</a>
      <div class="desc">${(it.description || '').replace(/</g, '&lt;')}</div>
      <div class="meta">prob: ${it.prob?.toFixed?.(2) || '0.00'} • ${new Date(it.collectedAt).toLocaleString()}</div>
    `;
    listEl.appendChild(li);
  }
}

async function refresh() {
  const status = await sendToActiveTab({ type: 'GET_STATUS' }).catch(() => null);
  if (status) {
    statusEl.textContent = `Status: ${status.scanning ? 'scanning' : 'idle'} ${status.faceApiReady ? '• model ready' : ''}`;
  } else {
    statusEl.textContent = 'Status: content script not active on this tab.';
  }

  const res = await sendToActiveTab({ type: 'GET_MATCHES' }).catch(() => null);
  renderList(res?.matches || []);
}

document.addEventListener('DOMContentLoaded', async () => {
  q('#startBtn').addEventListener('click', async () => {
    await sendToActiveTab({ type: 'START_SCAN' });
    refresh();
  });
  q('#stopBtn').addEventListener('click', async () => {
    await sendToActiveTab({ type: 'STOP_SCAN' });
    refresh();
  });
  q('#clearBtn').addEventListener('click', async () => {
    await sendToActiveTab({ type: 'CLEAR_LIST' });
    refresh();
  });
  q('#refreshBtn').addEventListener('click', refresh);

  q('#exportBtn').addEventListener('click', async () => {
    const res = await sendToActiveTab({ type: 'GET_MATCHES' }).catch(() => null);
    const items = res?.matches || [];
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `tiktok_matches_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  refresh();
});
