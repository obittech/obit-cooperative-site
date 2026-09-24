
const toggle = document.querySelector(".nav-toggle");
const nav = document.querySelector(".main-nav");
toggle?.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  toggle.setAttribute("aria-expanded", String(open));
});

function closeNav() {
  nav?.classList.remove("open");
  toggle?.setAttribute("aria-expanded", "false");
}
document.querySelectorAll(".main-nav a").forEach(link => {
  link.addEventListener("click", closeNav);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeNav();
    toggle?.focus();
  }
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
