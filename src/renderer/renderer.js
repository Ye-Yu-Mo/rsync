let currentView = 'list';
let editingTaskId = null;

document.addEventListener('DOMContentLoaded', () => {
  loadTasks();

  document.getElementById('new-task-btn').addEventListener('click', showNewTaskForm);
  document.getElementById('task-form').addEventListener('submit', saveTask);
  document.getElementById('cancel-btn').addEventListener('click', showTaskList);
  document.getElementById('test-conn-btn').addEventListener('click', testConnection);
  document.getElementById('close-log-btn').addEventListener('click', showTaskList);
});

async function loadTasks() {
  const tasks = await window.electronAPI.getTasks();
  const tbody = document.getElementById('tasks-tbody');
  tbody.innerHTML = '';

  tasks.forEach(task => {
    const tr = document.createElement('tr');

    const statusClass = task.last_sync_status === 'success' ? 'status-success' :
                       task.last_sync_status === 'fail' ? 'status-fail' :
                       task.is_running ? 'status-running' : '';

    const statusText = task.is_running ? '进行中' :
                      task.last_sync_status === 'success' ? '成功' :
                      task.last_sync_status === 'fail' ? '失败' : '-';

    const lastSyncTime = task.last_sync_time ?
      new Date(task.last_sync_time * 1000).toLocaleString('zh-CN') : '-';

    tr.innerHTML = `
      <td><a href="#" onclick="editTask(${task.id}); return false;">${task.name}</a></td>
      <td>${lastSyncTime}</td>
      <td class="${statusClass}">${statusText}</td>
      <td>
        <button onclick="syncTask(${task.id})" ${task.is_running ? 'disabled' : ''}>立即同步</button>
        <label>
          <input type="checkbox" ${task.enabled ? 'checked' : ''}
                 onchange="toggleTask(${task.id}, this.checked)">
          启用
        </label>
        <button onclick="viewLogs(${task.id})">查看日志</button>
        <button class="danger" onclick="deleteTask(${task.id})">删除</button>
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
    await window.electronAPI.syncTask(id);
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
  const logs = await window.electronAPI.getLogs(taskId);
  const container = document.getElementById('logs-container');
  container.innerHTML = '';

  logs.forEach(log => {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const timestamp = new Date(log.timestamp * 1000).toLocaleString('zh-CN');
    const mode = log.sync_mode ? ` [${log.sync_mode}]` : '';
    div.innerHTML = `
      <strong>[${timestamp}]</strong> ${log.status}${mode} (${log.duration}s)<br>
      <pre>${log.output || ''}</pre>
    `;
    container.appendChild(div);
  });

  document.getElementById('task-list-view').style.display = 'none';
  document.getElementById('log-view').style.display = 'block';
  currentView = 'log';
}

window.editTask = editTask;
window.syncTask = syncTask;
window.toggleTask = toggleTask;
window.deleteTask = deleteTask;
window.viewLogs = viewLogs;
