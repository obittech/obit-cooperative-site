const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('.main-nav');
const backdrop = document.createElement('button');
backdrop.className = 'nav-backdrop';
backdrop.type = 'button';
backdrop.hidden = true;
backdrop.tabIndex = -1;
backdrop.setAttribute('aria-label', 'Close navigation');
if (toggle && nav) {
  nav.id = nav.id || 'mainNavigation';
  toggle.setAttribute('aria-controls', nav.id);
  document.body.append(backdrop);
}
function closeNav(returnFocus = false) {
  nav?.classList.remove('open');
  toggle?.setAttribute('aria-expanded', 'false');
  toggle?.setAttribute('aria-label', 'Open navigation');
  if (toggle) toggle.textContent = '☰';
  backdrop.hidden = true;
  document.body.classList.remove('nav-open');
  if (returnFocus) toggle?.focus();
}
toggle?.addEventListener('click', () => {
  if (!nav) return;
  if (nav.classList.contains('open')) return closeNav();
  nav.classList.add('open');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Close navigation');
  toggle.textContent = '×';
  backdrop.hidden = false;
  document.body.classList.add('nav-open');
});
backdrop.addEventListener('click', () => closeNav(true));
document.addEventListener('pointerdown', event => {
  if (nav?.classList.contains('open') && !nav.contains(event.target) && !toggle?.contains(event.target)) closeNav();
});
document.querySelectorAll('.main-nav a').forEach(link => link.addEventListener('click', () => closeNav()));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && nav?.classList.contains('open')) closeNav(true);
});
window.matchMedia('(min-width: 1401px)').addEventListener('change', event => {
  if (event.matches) closeNav();
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll(".reveal").forEach(el => observer.observe(el));

document.querySelector("#leadForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const note = document.querySelector("#formNote");
  note.textContent = "Thank you. This demo captured the interaction. Connect the form to your CRM, WhatsApp, email or backend for live submissions.";
  note.style.color = "#05753f";
});
