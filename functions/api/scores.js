// Cloudflare Pages Function — served at /api/scores
// This is the hardcoded placeholder. Swap the array below for real
// STATS19 + green-space + OpenRouter-derived scores once the pipeline is built.

export async function onRequestGet(context) {
  const scores = [
    { id: 'GRN-001', name: 'Greenwich Park area', lat: 51.4769, lng: -0.0005, safety: 72, access: 68, fun: 80, composite: 73, justification: 'Low STATS19 incident density, strong park access.' },
    { id: 'GRN-002', name: 'Woolwich', lat: 51.4900, lng: 0.0648, safety: 55, access: 60, fun: 50, composite: 55, justification: 'Higher traffic incident rate near main road junctions.' },
    { id: 'GRN-003', name: 'Blackheath', lat: 51.4660, lng: 0.0090, safety: 78, access: 70, fun: 75, composite: 75, justification: 'Open heath access and low recorded incident rate.' }
  ];

  return new Response(JSON.stringify(scores), {
    headers: { 'Content-Type': 'application/json' }
  });
}
