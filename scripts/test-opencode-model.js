const baseUrl = (process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096').replace(/\/+$/, '');
const modelName = process.argv[2] || 'opencode/nemotron-3-ultra-free';
const separator = modelName.indexOf('/');

if (separator <= 0 || separator === modelName.length - 1) {
  console.error('Model must use provider/model format, for example: opencode/nemotron-3-ultra-free');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json' };
if (process.env.OPENCODE_API_KEY) {
  headers.Authorization = `Bearer ${process.env.OPENCODE_API_KEY}`;
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

async function main() {
  console.log(`Testing ${modelName} at ${baseUrl}`);
  const session = await post('/session', {});
  if (!session.id) throw new Error('OpenCode did not return a session id');

  const [providerID, ...modelParts] = modelName.split('/');
  const response = await post(`/session/${encodeURIComponent(session.id)}/message`, {
    model: { providerID, modelID: modelParts.join('/') },
    parts: [{ type: 'text', text: 'Reply with exactly: SPACH_MODEL_OK' }]
  });

  const parts = Array.isArray(response.parts) ? response.parts : (response.data?.parts || []);
  const text = parts
    .filter((part) => part && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  console.log(text || JSON.stringify(response, null, 2));
  console.log('Model responded successfully.');
}

main().catch((error) => {
  console.error(`Model test failed: ${error.message}`);
  process.exit(1);
});
