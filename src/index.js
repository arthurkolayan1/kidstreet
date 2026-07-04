export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/scores') {
      const scores = [
        {
          id: 'GRN-001',
          ward: 'Greenwich Park',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [-0.0102, 51.4805], [-0.0038, 51.4838], [0.0031, 51.4826],
              [0.0064, 51.4788], [0.0049, 51.4739], [-0.0011, 51.4712],
              [-0.0078, 51.4726], [-0.0102, 51.4770], [-0.0102, 51.4805]
            ]]
          },
          centroid: [51.4769, -0.0005],
          safety: 72,
          green: 85,
          narrative: 64,
          composite: 73,
          justification: 'Low recorded crime, excellent green access, council narrative broadly matches reality.'
        },
        {
          id: 'GRN-002',
          ward: 'Woolwich Riverside',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [0.0531, 51.4962], [0.0622, 51.4981], [0.0719, 51.4958],
              [0.0752, 51.4911], [0.0704, 51.4861], [0.0611, 51.4847],
              [0.0548, 51.4879], [0.0531, 51.4962]
            ]]
          },
          centroid: [51.4900, 0.0648],
          safety: 55,
          green: 48,
          narrative: 60,
          composite: 55,
          justification: 'Higher crime density near town centre, limited green space within walking distance.'
        },
        {
          id: 'GRN-003',
          ward: 'Blackheath Westcombe',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [0.0002, 51.4718], [0.0089, 51.4731], [0.0171, 51.4702],
              [0.0182, 51.4652], [0.0121, 51.4611], [0.0038, 51.4606],
              [-0.0009, 51.4648], [0.0002, 51.4718]
            ]]
          },
          centroid: [51.4660, 0.0090],
          safety: 78,
          green: 80,
          narrative: 68,
          composite: 76,
          justification: 'Open heath access, low recorded crime, council claims mostly supported by data.'
        }
      ];
      return new Response(JSON.stringify(scores), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
