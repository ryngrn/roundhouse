#!/usr/bin/env python3
"""Roundhouse project launcher. Read-only cloud directory; never dispatch work."""
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from PyQt6.QtCore import QObject, QThread, QTimer, QUrl, pyqtSignal
from PyQt6.QtGui import QAction, QDesktopServices, QIcon
from PyQt6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

BASE = 'https://roundhouse.ryan.green'
CONFIG = Path.home() / '.config/roundhouse/menu-config.json'
CACHE = Path.home() / '.cache/roundhouse/menu-projects.json'
ICON = Path(__file__).with_name('roundhouse.svg')


def normalized_projects(records):
    """Strictly validate cloud IDs; never accept a path from the server as a URL."""
    valid = []
    for value in records:
        ident = value.get('id') if isinstance(value, dict) else None
        if not isinstance(ident, str) or not ident or len(ident) > 120:
            continue
        if not all(part.isalnum() and part.isascii() and part.lower() == part
                   for part in ident.split('-')):
            continue
        name = value.get('name', ident)
        icon = value.get('icon') or '📁'
        valid.append({'id': ident, 'name': str(name)[:120], 'icon': str(icon)[:18]})
    return valid


def load_cache():
    try:
        return normalized_projects(json.loads(CACHE.read_text()).get('projects', []))
    except (OSError, ValueError, TypeError):
        return []


def cloud_fetch():
    config = json.loads(CONFIG.read_text())
    token = config.get('api_token')
    if not isinstance(token, str) or len(token) < 48:
        raise ValueError('Cloud project credentials missing')
    request = Request(BASE+'/api/menu-projects',
                      headers={'Authorization': 'Bearer '+token, 'Accept': 'application/json'})
    with urlopen(request, timeout=12) as response:
        obj = json.load(response)
    if not isinstance(obj.get('projects'), list):
        raise ValueError('Invalid cloud project directory')
    projects = normalized_projects(obj['projects'])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps({'projects': projects}, ensure_ascii=False))
    os.chmod(CACHE, 0o600)
    return projects, obj.get('stale') is True


class Loader(QObject):
    result = pyqtSignal(object, bool, str)
    def run(self):
        try:
            projects, stale = cloud_fetch()
            self.result.emit(projects, stale, '')
        except Exception:
            self.result.emit(None, False, 'Cloud unavailable — saved projects shown')


class ProjectTray(QObject):
    def __init__(self):
        super().__init__()
        self.app = QApplication.instance() or QApplication([])
        self.app.setQuitOnLastWindowClosed(False)
        self.tray = QSystemTrayIcon(QIcon(str(ICON)), self.app)
        self.tray.setToolTip('Roundhouse Projects')
        self.projects = load_cache()
        self.warning = 'Saved project directory' if self.projects else 'Connecting…'
        self.fetching = False
        self.worker_thread = None
        self.render()
        self.tray.show()
        self.timer = QTimer(self.tray)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(60000)
        self.refresh()

    def render(self):
        menu = QMenu()
        header = QAction('Roundhouse Projects', menu)
        header.setEnabled(False)
        menu.addAction(header)
        menu.addSeparator()
        if self.projects:
            for project in self.projects:
                action = QAction(project['icon']+'  '+project['name'], menu)
                link = BASE+'/projects/'+project['id']
                action.triggered.connect(lambda _=False, url=link: QDesktopServices.openUrl(QUrl(url)))
                menu.addAction(action)
        else:
            empty = QAction('No projects available', menu)
            empty.setEnabled(False)
            menu.addAction(empty)
        menu.addSeparator()
        if self.warning:
            message = QAction(self.warning, menu)
            message.setEnabled(False)
            menu.addAction(message)
        all_projects = menu.addAction('Open all projects ↗')
        all_projects.triggered.connect(lambda: QDesktopServices.openUrl(QUrl(BASE+'/projects')))
        refresh = menu.addAction('Refresh projects')
        refresh.triggered.connect(self.refresh)
        menu.addSeparator()
        quit_item = menu.addAction('Quit launcher')
        quit_item.triggered.connect(self.app.quit)
        self.tray.setContextMenu(menu)
        self.tray.setToolTip('Roundhouse Projects'+(' — '+self.warning if self.warning else ''))

    def refresh(self):
        if self.fetching:
            return
        self.fetching = True
        self.worker_thread = QThread()
        self.loader = Loader()
        self.loader.moveToThread(self.worker_thread)
        self.worker_thread.started.connect(self.loader.run)
        self.loader.result.connect(self.loaded)
        self.loader.result.connect(self.worker_thread.quit)
        self.worker_thread.finished.connect(self.loader.deleteLater)
        self.worker_thread.finished.connect(self.worker_thread.deleteLater)
        self.worker_thread.start()

    def loaded(self, projects, stale, error):
        self.fetching = False
        if projects is not None:
            self.projects = projects
            self.warning = 'Studio snapshot delayed' if stale else ''
        else:
            self.warning = error
        self.render()


if __name__ == '__main__':
    launcher = ProjectTray()
    if not QSystemTrayIcon.isSystemTrayAvailable():
        raise SystemExit('No KDE system tray is available')
    raise SystemExit(launcher.app.exec())
