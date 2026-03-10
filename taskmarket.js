// Fetches task creator address from Taskmarket API
async function getTaskCreator(taskId) {
  try {
    const res = await fetch(`https://api-market.daydreams.systems/api/tasks/${taskId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.requester || null;
  } catch {
    return null;
  }
}

module.exports = { getTaskCreator };
