(function () {
  // Find our own <script> tag to read the business ID off it — this is
  // what makes the "one script tag" embed pattern work without needing
  // the business to write any extra HTML.
  const scripts = document.querySelectorAll('script[src*="widget.js"]');
  const thisScript = scripts[scripts.length - 1];
  const businessId = thisScript && thisScript.getAttribute('data-business');

  if (!businessId) {
    console.error('[SuggestionsBox widget] Missing data-business attribute on the script tag.');
    return;
  }

  const API_BASE = 'https://api.suggestionsbox.com.au';
  const STATUS_LABELS = { sent: 'Sent', seen: 'Seen', acknowledged: 'Acknowledged', in_progress: 'In progress', actioned: 'Actioned', not_planned: 'Not planned' };

  // Every class is prefixed sb-w- and scoped under a single wrapper so
  // this can't collide with whatever CSS the host site already has.
  const STYLE = `
    .sb-w-root{
      --sb-w-terra:#E2653A; --sb-w-terra-deep:#B84B29; --sb-w-gold:#D9A441;
      --sb-w-cream:#FCF6EC; --sb-w-ink:#2E2B28; --sb-w-ink-soft:#6E6A63; --sb-w-line:#EDE0CC;
      --sb-w-good-ink:#5E7A1F;
      all:initial; box-sizing:border-box; display:block; font-family:'Work Sans',Arial,sans-serif;
      max-width:820px; margin:0 auto; background:#FFFFFF; border:1px solid var(--sb-w-line);
      border-radius:16px; box-shadow:0 1px 2px rgba(46,38,32,.04), 0 10px 28px rgba(46,38,32,.08);
      padding:22px 22px 20px;
    }
    .sb-w-root *{box-sizing:border-box;}
    .sb-w-head{display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:14px;}
    .sb-w-head-left{display:flex; align-items:center; gap:10px;}
    .sb-w-mark{width:30px; height:30px; flex-shrink:0;}
    .sb-w-title{font-family:'Fredoka',Arial,sans-serif; font-weight:600; font-size:15.5px; color:var(--sb-w-ink); line-height:1.25;}
    .sb-w-title span{display:block; font-family:'Space Mono',monospace; font-weight:400; font-size:10.5px; color:var(--sb-w-ink-soft); margin-top:1px;}
    .sb-w-cta{
      font-family:inherit; font-weight:600; font-size:12.5px; color:var(--sb-w-terra-deep); text-decoration:none;
      white-space:nowrap; border:1.5px solid var(--sb-w-terra); padding:7px 13px; border-radius:20px;
      transition:background .15s ease, color .15s ease;
    }
    .sb-w-cta:hover{background:var(--sb-w-terra); color:#fff;}
    .sb-w-track-wrap{position:relative;}
    .sb-w-track{display:flex; gap:16px; overflow-x:auto; scroll-behavior:smooth; scroll-snap-type:x mandatory; padding:4px 4px 10px; -ms-overflow-style:none; scrollbar-width:none;}
    .sb-w-track::-webkit-scrollbar{display:none;}
    .sb-w-card{
      flex:0 0 270px; scroll-snap-align:start; background:#fff; border:1px solid var(--sb-w-line);
      border-radius:12px; padding:22px 18px 16px; display:flex; flex-direction:column; gap:12px;
      box-shadow:0 1px 2px rgba(46,38,32,.04); transition:transform .15s ease, box-shadow .15s ease;
      position:relative; overflow:hidden;
    }
    .sb-w-card::before{
      content:""; position:absolute; top:0; left:0; right:0; height:10px;
      background-image: radial-gradient(circle at 6px 6px, var(--sb-w-cream) 3px, transparent 3.5px);
      background-size: 12px 10px; background-repeat:repeat-x; background-position:top center;
    }
    .sb-w-card:hover{transform:translateY(-2px); box-shadow:0 8px 20px rgba(46,38,32,.08);}
    .sb-w-card-top{display:flex; justify-content:space-between; align-items:flex-start; gap:10px;}
    .sb-w-tag{font-family:'Space Mono',monospace; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--sb-w-terra-deep); background:#FBEFE7; padding:4px 9px; border-radius:6px;}
    .sb-w-votes{display:flex; align-items:center; gap:4px; color:var(--sb-w-ink-soft); font-family:'Space Mono',monospace; font-size:12px; flex-shrink:0;}
    .sb-w-meta{font-family:'Space Mono',monospace; font-size:10.5px; color:var(--sb-w-ink-soft);}
    .sb-w-status-pill{display:inline-block; padding:3px 9px; border-radius:6px; font-size:9.5px; font-family:'Fredoka',Arial,sans-serif; font-weight:600; margin-bottom:6px;}
    .sb-w-status-pill.sent{background:#EFEAE3; color:var(--sb-w-ink-soft);}
    .sb-w-status-pill.seen{background:#E4EEFB; color:#3A5F8A;}
    .sb-w-status-pill.acknowledged{background:#FBEBD9; color:var(--sb-w-terra-deep);}
    .sb-w-status-pill.in_progress{background:#FBF1D0; color:#9A7A15;}
    .sb-w-status-pill.actioned{background:#EFF4DE; color:var(--sb-w-good-ink);}
    .sb-w-status-pill.not_planned{background:#EFEAE3; color:var(--sb-w-ink-soft);}
    .sb-w-votes svg{width:11px; height:11px; fill:var(--sb-w-gold);}
    .sb-w-quote{font-size:13.5px; line-height:1.5; color:var(--sb-w-ink);}
    .sb-w-resp{background:var(--sb-w-cream); border-radius:9px; padding:12px 13px; border-left:3px solid var(--sb-w-gold);}
    .sb-w-resp p{margin:0; font-size:12.5px; line-height:1.45; color:var(--sb-w-ink);}
    .sb-w-arrow{
      position:absolute; top:50%; transform:translateY(-50%); width:32px; height:32px; border-radius:50%;
      border:1px solid var(--sb-w-line); background:#fff; cursor:pointer; display:flex; align-items:center;
      justify-content:center; box-shadow:0 2px 6px rgba(46,38,32,.10); z-index:2;
    }
    .sb-w-arrow svg{width:13px; height:13px; fill:none; stroke:var(--sb-w-terra-deep); stroke-width:2.4;}
    .sb-w-arrow.sb-w-prev{left:-14px;}
    .sb-w-arrow.sb-w-next{right:-14px;}
    .sb-w-dots{display:flex; justify-content:center; gap:6px; margin-top:10px;}
    .sb-w-dot{width:6px; height:6px; border-radius:50%; background:var(--sb-w-line); border:none; padding:0; cursor:pointer;}
    .sb-w-dot.sb-w-active{background:var(--sb-w-terra); transform:scale(1.3);}
    .sb-w-empty{font-size:12.5px; color:var(--sb-w-ink-soft); text-align:center; padding:20px 0;}
    @media (max-width:560px){
      .sb-w-arrow{display:none;}
      .sb-w-card{flex-basis:220px;}
    }
  `;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  function heartSvg() {
    return '<svg viewBox="0 0 20 20"><path d="M10 17s-6.5-4.1-8.5-8.2C.3 6.1 1.7 3 4.7 3c1.7 0 3 .9 3.7 2.1C9.1 3.9 10.4 3 12.1 3c3 0 4.4 3.1 3.2 5.8C14.5 12.9 10 17 10 17z"/></svg>';
  }

  function logoSvg() {
    return `<svg class="sb-w-mark" viewBox="0 0 200 200"><path d="M54,14 H142 L186,58 V146 Q186,186 146,186 H54 Q14,186 14,146 V54 Q14,14 54,14 Z" fill="#FCF6EC" stroke="#E9DCC5" stroke-width="4"/><path d="M142,14 L186,58 L142,58 Z" fill="#ECDBBE"/><circle cx="70" cy="76" r="8" fill="#E2653A"/><circle cx="130" cy="76" r="8" fill="#E2653A"/><path d="M64 106 Q100 130 136 106" stroke="#E2653A" stroke-width="15" stroke-linecap="round" fill="none"/></svg>`;
  }

  function buildWidget(container, wall) {
    const items = wall.items || [];
    const boardUrl = `https://app.suggestionsbox.com.au/board.html?business=${businessId}`;

    if (items.length === 0) {
      container.innerHTML = `
        <div class="sb-w-root">
          <div class="sb-w-head">
            <div class="sb-w-head-left">
              ${logoSvg()}
              <div class="sb-w-title">What we've changed, because you told us<span>${escapeHtml(wall.businessName)} · Suggestions Box</span></div>
            </div>
            <a class="sb-w-cta" href="${boardUrl}" target="_blank" rel="noopener">Leave a note</a>
          </div>
          <div class="sb-w-empty">Nothing published yet — check back soon.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="sb-w-root" id="sbWidgetRoot">
        <div class="sb-w-head">
          <div class="sb-w-head-left">
            ${logoSvg()}
            <div class="sb-w-title">What we've changed, because you told us<span>${escapeHtml(wall.businessName)} · Suggestions Box</span></div>
          </div>
          <a class="sb-w-cta" href="${boardUrl}" target="_blank" rel="noopener">Leave a note</a>
        </div>
        <div class="sb-w-track-wrap">
          <button class="sb-w-arrow sb-w-prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
          <div class="sb-w-track" id="sbWidgetTrack">
            ${items.map((i) => `
              <div class="sb-w-card">
                <div class="sb-w-card-top">
                  <span class="sb-w-tag">${escapeHtml(i.category)}</span>
                  <span class="sb-w-votes">${heartSvg()} ${i.voteCount}</span>
                </div>
                <div class="sb-w-quote">"${escapeHtml(i.text)}"</div>
                <div class="sb-w-meta">${escapeHtml(i.displayName)} · ${timeAgo(i.createdAt)}</div>
                <div class="sb-w-resp">
                  <span class="sb-w-status-pill ${i.status}">${STATUS_LABELS[i.status] || i.status}</span>
                  <p>${i.response ? escapeHtml(i.response) : "No written response yet."}</p>
                </div>
              </div>
            `).join('')}
          </div>
          <button class="sb-w-arrow sb-w-next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
        </div>
        <div class="sb-w-dots" id="sbWidgetDots">
          ${items.map((_, i) => `<button class="sb-w-dot ${i === 0 ? 'sb-w-active' : ''}" data-i="${i}"></button>`).join('')}
        </div>
      </div>
    `;

    wireSlider(container, items.length);
  }

  function wireSlider(container, count) {
    const track = container.querySelector('#sbWidgetTrack');
    const dotsWrap = container.querySelector('#sbWidgetDots');
    const root = container.querySelector('#sbWidgetRoot');
    let current = 0;
    let autoplayTimer = null;

    function cardWidth() {
      const card = track.querySelector('.sb-w-card');
      return card ? card.offsetWidth + 16 : 286;
    }
    function updateDots() {
      dotsWrap.querySelectorAll('.sb-w-dot').forEach((d, i) => d.classList.toggle('sb-w-active', i === current));
    }
    function goTo(i) {
      current = Math.max(0, Math.min(count - 1, i));
      track.scrollTo({ left: current * cardWidth(), behavior: 'smooth' });
      updateDots();
      restartAutoplay();
    }
    function autoAdvance() {
      current = (current + 1) % count;
      track.scrollTo({ left: current * cardWidth(), behavior: 'smooth' });
      updateDots();
    }
    function startAutoplay() { if (count > 1) autoplayTimer = setInterval(autoAdvance, 4500); }
    function restartAutoplay() { clearInterval(autoplayTimer); startAutoplay(); }

    container.querySelector('.sb-w-prev').addEventListener('click', () => goTo(current - 1));
    container.querySelector('.sb-w-next').addEventListener('click', () => goTo(current + 1));
    dotsWrap.querySelectorAll('.sb-w-dot').forEach((d) => d.addEventListener('click', () => goTo(parseInt(d.dataset.i, 10))));

    root.addEventListener('mouseenter', () => clearInterval(autoplayTimer));
    root.addEventListener('mouseleave', startAutoplay);
    track.addEventListener('touchstart', () => clearInterval(autoplayTimer));
    track.addEventListener('touchend', restartAutoplay);

    let scrollTimeout;
    track.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        current = Math.round(track.scrollLeft / cardWidth());
        updateDots();
      }, 100);
    });

    startAutoplay();
  }

  async function init() {
    // Google Fonts is optional — if it fails to load (ad blocker, offline,
    // whatever) the widget still renders fine in system fonts.
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Work+Sans:wght@400;500;600&family=Space+Mono&display=swap';
    document.head.appendChild(fontLink);

    const styleTag = document.createElement('style');
    styleTag.textContent = STYLE;
    document.head.appendChild(styleTag);

    const container = document.createElement('div');
    thisScript.parentNode.insertBefore(container, thisScript.nextSibling);
    container.innerHTML = '<div class="sb-w-root"><div class="sb-w-empty">Loading…</div></div>';

    try {
      const res = await fetch(`${API_BASE}/api/board/${businessId}/wall`);
      if (!res.ok) throw new Error('not found');
      const wall = await res.json();
      buildWidget(container, wall);
    } catch (err) {
      container.innerHTML = '';
      console.error('[SuggestionsBox widget] Failed to load:', err.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
