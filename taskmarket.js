// Fetches task creator address from Taskmarket API
async function getTaskCreator(taskId) {
  try {
    const res = await fetch(`https://api.taskmarket.xyz/task/${taskId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.requester || null;
  } catch {
    return null;
  }
}

module.exports = { getTaskCreator };
