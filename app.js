const events = [
  { status: "LIVE READY", title: "DC Live Broadcast", description: "A clean viewer entry point for a live program feed.", meta: "Live access", action: "Open event" },
  { status: "UPCOMING", title: "Featured Event", description: "Event listings from the backend will populate this space when connected.", meta: "Scheduled", action: "View details" },
  { status: "ON DEMAND", title: "Replay Rental", description: "Protected replay rentals can use viewer login and entitlement checks.", meta: "Rental access", action: "See replay" }
];

const grid = document.querySelector("#event-grid");
grid.innerHTML = events.map(event => `
  <article class="event-card">
    <div>
      <span class="event-status">${event.status}</span>
      <h3>${event.title}</h3>
      <p>${event.description}</p>
    </div>
    <div class="event-bottom">
      <span>${event.meta}</span>
      <a href="#how">${event.action} →</a>
    </div>
  </article>
`).join("");
