// Fetches task creator address from Taskmarket API
const TASKMARKET_API = process.env.TASKMARKET_API || 'https://api.taskmarket.dev';

async function getTaskCreator(taskId) {
  try {
    const res = await fetch(`${TASKMARKET_API}/api/tasks/${taskId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.requester || null;
  } catch {
    return null;
  }
}

module.exports = { getTaskCreator };
