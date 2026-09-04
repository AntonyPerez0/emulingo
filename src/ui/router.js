export function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  const ev = new CustomEvent('tabchange', { detail: { tab: name } });
  window.dispatchEvent(ev);
}

export function activeTab() {
  const el = document.querySelector('.tab.active');
  return el ? el.dataset.tab : 'play';
}
