// Shared header (with mega menu) and footer for public marketing pages:
// index.html, about.html, contact.html, privacy.html.
// NOT used on app pages (dashboard/profile/subscription/billing/signup/onboarding)
// — those have their own app-shell header, which is the right pattern once
// someone is inside the logged-in product rather than browsing the marketing site.

const SIGNAL_HEADER_HTML = `
<header class="sg-header">
  <div class="sg-header-inner">
    <a href="/" class="sg-logo"><span class="sg-logo-mark"></span>Signal<span class="sg-beta-badge">BETA</span></a>
    <nav class="sg-nav">
      <div class="sg-nav-item" data-menu="product">
        <span>Product</span>
        <div class="sg-mega">
          <a href="/dashboard.html"><strong>Dashboard</strong><span>Overview, timelines, alerts</span></a>
          <a href="/#tool"><strong>Free page check</strong><span>No signup, instant diff</span></a>
          <a href="/#features"><strong>Site-wide scan</strong><span>Find new pages + broken links</span></a>
          <a href="/leaderboard"><strong>Velocity leaderboard</strong><span>Who's publishing fastest</span></a>
        </div>
      </div>
      <a href="/subscription.html" class="sg-nav-item">Pricing</a>
      <div class="sg-nav-item" data-menu="company">
        <span>Company</span>
        <div class="sg-mega sg-mega-small">
          <a href="/about.html"><strong>About</strong><span>Why we built Signal</span></a>
          <a href="/contact.html"><strong>Contact</strong><span>Get in touch</span></a>
          <a href="/privacy.html"><strong>Privacy</strong><span>Our data policy</span></a>
        </div>
      </div>
    </nav>
    <div class="sg-header-cta">
      <a href="/demo" class="sg-link-btn">View demo</a>
      <a href="/signup.html" class="sg-fill-btn">Sign up →</a>
    </div>
    <button class="sg-mobile-toggle" id="sgMobileToggle">☰</button>
  </div>
  <div class="sg-mobile-menu" id="sgMobileMenu">
    <a href="/dashboard.html">Dashboard</a>
    <a href="/#tool">Free page check</a>
    <a href="/leaderboard">Velocity leaderboard</a>
    <a href="/subscription.html">Pricing</a>
    <a href="/about.html">About</a>
    <a href="/contact.html">Contact</a>
    <a href="/privacy.html">Privacy</a>
    <a href="/demo">View demo</a>
    <a href="/signup.html" class="sg-mobile-cta">Sign up →</a>
  </div>
</header>
`;

const SIGNAL_FOOTER_HTML = `
<footer class="sg-footer">
  <div class="sg-footer-inner">
    <div class="sg-footer-col sg-footer-brand">
      <div class="sg-logo"><span class="sg-logo-mark"></span>Signal</div>
      <p>A focused competitor change tracker for SEOs and content teams.</p>
    </div>
    <div class="sg-footer-col">
      <h4>Product</h4>
      <a href="/dashboard.html">Dashboard</a>
      <a href="/#tool">Free page check</a>
      <a href="/leaderboard">Leaderboard</a>
      <a href="/subscription.html">Pricing</a>
    </div>
    <div class="sg-footer-col">
      <h4>Company</h4>
      <a href="/about.html">About</a>
      <a href="/contact.html">Contact</a>
      <a href="/privacy.html">Privacy Policy</a>
    </div>
    <div class="sg-footer-col">
      <h4>Account</h4>
      <a href="/signup.html">Sign up</a>
      <a href="/demo">View demo</a>
      <a href="/dashboard.html">Dashboard</a>
    </div>
  </div>
  <div class="sg-footer-bottom">© 2026 Signal. Independent project, not affiliated with the SEO tools it complements.</div>
</footer>
`;

const SIGNAL_HEADER_FOOTER_CSS = `
<style>
  .sg-header{background:#fff;border-bottom:1px solid var(--line, #E4E2DC);position:relative;z-index:100;}
  .sg-header-inner{max-width:1100px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;gap:32px;}
  .sg-logo{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:19px;color:var(--ink,#0F172A);display:flex;align-items:center;gap:8px;text-decoration:none;}
  .sg-logo-mark{width:10px;height:10px;background:var(--amber,#E8A33D);border-radius:2px;transform:rotate(45deg);flex-shrink:0;}
  .sg-beta-badge{font-family:'Inter',sans-serif;font-size:10px;font-weight:700;background:var(--ink,#0F172A);color:#fff;padding:2px 7px;border-radius:8px;margin-left:6px;vertical-align:middle;letter-spacing:0.03em;}
  .sg-nav{display:flex;gap:8px;flex:1;}
  .sg-nav-item{position:relative;padding:10px 14px;font-size:14px;font-weight:500;color:var(--text,#1A1D23);cursor:pointer;text-decoration:none;border-radius:6px;transition:background 0.15s;}
  .sg-nav-item:hover{background:var(--paper,#F7F7F5);}
  .sg-mega{display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid var(--line,#E4E2DC);border-radius:10px;box-shadow:0 12px 32px rgba(15,23,42,0.12);padding:12px;min-width:280px;grid-template-columns:1fr;gap:2px;margin-top:6px;}
  .sg-mega a{display:block;padding:10px 12px;border-radius:7px;text-decoration:none;transition:background 0.15s;}
  .sg-mega a:hover{background:var(--paper,#F7F7F5);}
  .sg-mega a strong{display:block;font-size:13px;color:var(--text,#1A1D23);font-weight:600;}
  .sg-mega a span{display:block;font-size:12px;color:var(--muted,#6B7280);margin-top:2px;}
  .sg-mega-small{min-width:220px;}
  .sg-nav-item:hover .sg-mega{display:grid;}
  .sg-header-cta{display:flex;align-items:center;gap:10px;}
  .sg-link-btn{font-size:14px;font-weight:500;color:var(--muted,#6B7280);text-decoration:none;padding:9px 12px;transition:color 0.15s;}
  .sg-link-btn:hover{color:var(--ink,#0F172A);}
  .sg-fill-btn{font-size:14px;font-weight:700;color:var(--ink,#0F172A);background:var(--amber,#E8A33D);text-decoration:none;padding:9px 16px;border-radius:7px;transition:background 0.15s;}
  .sg-fill-btn:hover{background:#f0ae4d;}
  .sg-mobile-toggle{display:none;background:none;border:none;font-size:20px;cursor:pointer;}
  .sg-mobile-menu{display:none;flex-direction:column;padding:8px 24px 16px;border-top:1px solid var(--line,#E4E2DC);}
  .sg-mobile-menu a{padding:10px 4px;font-size:14px;color:var(--text,#1A1D23);text-decoration:none;border-bottom:1px solid var(--line,#E4E2DC);}
  .sg-mobile-menu a.sg-mobile-cta{color:var(--ink,#0F172A);font-weight:700;border-bottom:none;}
  .sg-mobile-menu.open{display:flex;}

  @media(max-width:820px){
    .sg-nav,.sg-header-cta{display:none;}
    .sg-mobile-toggle{display:block;}
  }

  .sg-footer{background:var(--ink,#0F172A);color:#B6BDCB;margin-top:0;}
  .sg-footer-inner{max-width:1100px;margin:0 auto;padding:48px 24px 24px;display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:32px;}
  @media(max-width:760px){.sg-footer-inner{grid-template-columns:1fr 1fr;}}
  .sg-footer-brand .sg-logo{color:#fff;margin-bottom:10px;}
  .sg-footer-brand p{font-size:13px;color:#7C8496;margin:0;line-height:1.6;}
  .sg-footer-col h4{font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#7C8496;margin:0 0 12px;font-weight:600;}
  .sg-footer-col a{display:block;font-size:14px;color:#B6BDCB;text-decoration:none;margin-bottom:9px;transition:color 0.15s;}
  .sg-footer-col a:hover{color:#fff;}
  .sg-footer-bottom{max-width:1100px;margin:0 auto;padding:20px 24px;border-top:1px solid #1E293B;font-size:12px;color:#7C8496;}
</style>
`;

document.addEventListener('DOMContentLoaded', () => {
  const headerMount = document.getElementById('sg-header-mount');
  const footerMount = document.getElementById('sg-footer-mount');
  document.head.insertAdjacentHTML('beforeend', SIGNAL_HEADER_FOOTER_CSS);
  if (headerMount) headerMount.outerHTML = SIGNAL_HEADER_HTML;
  if (footerMount) footerMount.outerHTML = SIGNAL_FOOTER_HTML;

  const toggle = document.getElementById('sgMobileToggle');
  const mobileMenu = document.getElementById('sgMobileMenu');
  if (toggle && mobileMenu) {
    toggle.addEventListener('click', () => mobileMenu.classList.toggle('open'));
  }
});
