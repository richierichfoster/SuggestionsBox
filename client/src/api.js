const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function getDeviceId() {
  let id = localStorage.getItem('sb_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('sb_device_id', id);
  }
  return id;
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  getBusiness: () => request('/api/business'),

  getNotes: () => request(`/api/notes?deviceId=${getDeviceId()}`),

  getNote: (id) => request(`/api/notes/${id}?deviceId=${getDeviceId()}`),

  checkTone: (text) => request('/api/moderate', { method: 'POST', body: JSON.stringify({ text }) }),

  submitNote: (payload) =>
    request('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ ...payload, deviceId: getDeviceId() }),
    }),

  vote: (id) =>
    request(`/api/notes/${id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: getDeviceId() }),
    }),

  ownerLogin: (passcode) =>
    request('/api/owner/login', { method: 'POST', body: JSON.stringify({ passcode }) }),

  ownerUpdateStatus: (id, status, message, passcode) =>
    request(`/api/owner/notes/${id}/status`, {
      method: 'POST',
      headers: { 'x-owner-passcode': passcode },
      body: JSON.stringify({ status, message }),
    }),

  getDeviceId,
};
