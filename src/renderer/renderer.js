let currentView = 'list';
let editingTaskId = null;

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  loadTasks();

  document.getElementById('new-task-btn').addEventListener('click', showNewTaskForm);
  document.getElementById('task-form').addEventListener('submit', saveTask);
  document.getElementById('cancel-btn').addEventListener('click', showTaskList);
  document.getElementById('test-conn-btn').addEventListener('click', testConnection);
  document.getElementById('close-log-btn').addEventListener('click', showTaskList);

  // Listen for backend updates
  window.electronAPI.onTaskUpdate(() => {
    // Refresh list if in list view
    if (currentView === 'list') {
      loadTasks();
    } 
    // Also refresh logs if we are viewing logs
    else if (currentView === 'log') {
      if (typeof currentViewingTaskId !== 'undefined' && currentViewingTaskId) {
        viewLogs(currentViewingTaskId);
      }
    }
  });

  window.electronAPI.onTaskProgress((event, data) => {
    if (currentView !== 'list') return;
    
    const { taskId, percent, speed } = data;
    const progressContainer = document.getElementById(`progress-container-${taskId}`);
    const progressBar = document.getElementById(`progress-bar-${taskId}`);
    const progressText = document.getElementById(`progress-text-${taskId}`);
    const statusBadge = document.getElementById(`status-badge-${taskId}`);

    if (progressContainer && progressBar && progressText) {
      progressContainer.style.display = 'block';
      progressBar.style.width = percent;
      progressText.textContent = `${percent} @ ${speed}`;
      
      if (statusBadge) {
        statusBadge.textContent = '运行中...';
        statusBadge.className = 'status-badge status-running';
      }
    }
  });
});

let currentViewingTaskId = null;

async function loadTasks() {
  const tasks = await window.electronAPI.getTasks();
  const tbody = document.getElementById('tasks-tbody');
  tbody.innerHTML = '';

  if (tasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:2rem;">暂无任务，请点击右上角新建</td></tr>';
    return;
  }

  tasks.forEach(task => {
    const tr = document.createElement('tr');

    let statusClass = 'status-idle';
    let statusText = '就绪';

    if (task.is_running) {
      statusClass = 'status-running';
      statusText = '运行中...';
    } else if (task.last_sync_status === 'success') {
      statusClass = 'status-success';
      statusText = '成功';
    } else if (task.last_sync_status === 'fail') {
      statusClass = 'status-fail';
      statusText = '失败';
    }

    const lastSyncTime = task.last_sync_time ?
      new Date(task.last_sync_time * 1000).toLocaleString('zh-CN', { hour12: false }) : '-';
    const safeLastSyncTime = escapeHtml(lastSyncTime);
    const safeName = escapeHtml(task.name);
    const safeRemoteInfo = `${escapeHtml(task.remote_host)}:${escapeHtml(task.remote_dir)}`;
    
    // Toggle button style
    const toggleBtnText = task.enabled ? '暂停' : '启用';
    const toggleBtnClass = task.enabled ? 'secondary' : ''; // Highlight 'Enable' if disabled

    tr.innerHTML = `
      <td>
        <div style="font-weight:600">${safeName}</div>
        <div style="font-size:0.75rem;color:#6b7280">${safeRemoteInfo}</div>
        <!-- Progress bar container -->
        <div id="progress-container-${task.id}" style="display:none; margin-top:4px;">
           <div style="background:#e5e7eb;height:4px;border-radius:2px;overflow:hidden;">
             <div id="progress-bar-${task.id}" style="background:#3b82f6;height:100%;width:0%;transition:width 0.2s"></div>
           </div>
           <div id="progress-text-${task.id}" style="font-size:0.7rem;color:#6b7280;margin-top:2px;"></div>
        </div>
      </td>
      <td style="font-size:0.85rem">${safeLastSyncTime}</td>
      <td><span id="status-badge-${task.id}" class="status-badge ${statusClass}">${statusText}</span></td>
      <td class="flex gap-2">
        <button onclick="syncTask(${task.id})" ${task.is_running ? 'disabled' : ''} style="padding:0.25rem 0.5rem;font-size:0.75rem">同步</button>
        <button class="${toggleBtnClass}" onclick="toggleTask(${task.id}, ${!task.enabled})" style="padding:0.25rem 0.5rem;font-size:0.75rem">${toggleBtnText}</button>
        <button class="secondary" onclick="editTask(${task.id})" style="padding:0.25rem 0.5rem;font-size:0.75rem">编辑</button>
        <button class="secondary" onclick="viewLogs(${task.id})" style="padding:0.25rem 0.5rem;font-size:0.75rem">日志</button>
        <button class="danger" onclick="deleteTask(${task.id})" style="padding:0.25rem 0.5rem;font-size:0.75rem">删除</button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

function showTaskList() {
  document.getElementById('task-list-view').style.display = 'block';
  document.getElementById('task-edit-view').style.display = 'none';
  document.getElementById('log-view').style.display = 'none';
  currentView = 'list';
  loadTasks();
}

function showNewTaskForm() {
  editingTaskId = null;
  document.getElementById('edit-title').textContent = '新建任务';
  document.getElementById('task-form').reset();
  document.getElementById('task-id').value = '';
  document.getElementById('task-list-view').style.display = 'none';
  document.getElementById('task-edit-view').style.display = 'block';
  currentView = 'edit';
}

async function editTask(id) {
  editingTaskId = id;
  const task = await window.electronAPI.getTask(id);

  document.getElementById('edit-title').textContent = '编辑任务';
  document.getElementById('task-id').value = task.id;
  document.getElementById('task-name').value = task.name;
  document.getElementById('remote-host').value = task.remote_host;
  document.getElementById('remote-port').value = task.remote_port;
  document.getElementById('username').value = task.username;
  document.getElementById('password').value = task.password;
  document.getElementById('local-dir').value = task.local_dir;
  document.getElementById('remote-dir').value = task.remote_dir;
  document.getElementById('interval').value = task.interval_minutes;
  document.getElementById('version-enabled').checked = task.version_enabled;
  document.getElementById('trash-enabled').checked = task.trash_enabled;

  document.getElementById('task-list-view').style.display = 'none';
  document.getElementById('task-edit-view').style.display = 'block';
  currentView = 'edit';
}

async function saveTask(e) {
  e.preventDefault();

  const task = {
    name: document.getElementById('task-name').value,
    remote_host: document.getElementById('remote-host').value,
    remote_port: parseInt(document.getElementById('remote-port').value),
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
    local_dir: document.getElementById('local-dir').value,
    remote_dir: document.getElementById('remote-dir').value,
    interval_minutes: parseInt(document.getElementById('interval').value),
    version_enabled: document.getElementById('version-enabled').checked ? 1 : 0,
    trash_enabled: document.getElementById('trash-enabled').checked ? 1 : 0
  };

  try {
    if (editingTaskId) {
      await window.electronAPI.updateTask(editingTaskId, task);
    } else {
      await window.electronAPI.createTask(task);
    }
    showTaskList();
  } catch (error) {
    alert('保存失败: ' + error.message);
  }
}

async function testConnection() {
  const config = {
    remote_host: document.getElementById('remote-host').value,
    remote_port: parseInt(document.getElementById('remote-port').value),
    username: document.getElementById('username').value,
    password: document.getElementById('password').value
  };

  try {
    const result = await window.electronAPI.testConnection(config);
    alert(result.success ? '连接成功' : '连接失败: ' + result.error);
  } catch (error) {
    alert('测试失败: ' + error.message);
  }
}

async function syncTask(id) {
  try {
    const result = await window.electronAPI.syncTask(id);
    if (!result.success) {
      alert('同步失败: ' + (result.error || '未知错误'));
    }
    loadTasks();
  } catch (error) {
    alert('同步失败: ' + error.message);
  }
}

async function toggleTask(id, enabled) {
  try {
    await window.electronAPI.toggleTask(id, enabled);
    loadTasks();
  } catch (error) {
    alert('操作失败: ' + error.message);
  }
}

async function deleteTask(id) {
  if (!confirm('确认删除此任务？')) return;

  try {
    await window.electronAPI.deleteTask(id);
    loadTasks();
  } catch (error) {
    alert('删除失败: ' + error.message);
  }
}

async function viewLogs(taskId) {
  currentViewingTaskId = taskId;
  const logs = await window.electronAPI.getLogs(taskId);
  const container = document.getElementById('logs-container');
  container.innerHTML = '';

  if (logs.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#6b7280;padding:2rem;">暂无日志记录</div>';
  } else {
    logs.forEach(log => {
      const logEntry = document.createElement('div');
      logEntry.className = 'log-entry';
      const timestamp = new Date(log.timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
      const statusColor = log.status === 'success' ? '#34d399' : '#f87171';

      const meta = document.createElement('div');
      meta.className = 'log-meta';

      const timeSpan = document.createElement('span');
      timeSpan.textContent = timestamp;

      const statusSpan = document.createElement('span');
      statusSpan.style.color = statusColor;
      statusSpan.textContent = log.status.toUpperCase();

      const durationSpan = document.createElement('span');
      durationSpan.textContent = `${log.duration}s`;

      const modeSpan = document.createElement('span');
      modeSpan.textContent = `[${log.sync_mode || 'rsync'}]`;

      meta.appendChild(timeSpan);
      meta.appendChild(statusSpan);
      meta.appendChild(durationSpan);
      meta.appendChild(modeSpan);

      const outputDiv = document.createElement('div');
      outputDiv.className = 'log-output';
      outputDiv.textContent = log.output || '(无输出)';

      logEntry.appendChild(meta);
      logEntry.appendChild(outputDiv);
      container.appendChild(logEntry);
    });
  }

  document.getElementById('task-list-view').style.display = 'none';
  document.getElementById('log-view').style.display = 'block';
  currentView = 'log';
}

window.editTask = editTask;
window.syncTask = syncTask;
window.toggleTask = toggleTask;
window.deleteTask = deleteTask;
window.viewLogs = viewLogs;
