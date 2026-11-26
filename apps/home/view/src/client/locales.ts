/** `home` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'home'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'app.name': '主页',
  'app.description': '总览各应用的状态与最近发生的变化。',
  'view.overview': '概览',
  'view.activity': '最近变化',
  'view.activityEmpty': '暂时没有新的变化。',
  'view.activityLine': '{app} · {count} 条新内容',
  'view.activityOne': '{app} · 1 条新内容',
  'view.open': '打开',
  'view.loading': '正在读取…',
  'view.notRead': '尚未读取',
  'view.retry': '重试',
  'view.refresh': '刷新',
  'view.refreshing': '正在刷新…',
  'view.updatedAt': '更新于 {time}',
  'view.diagnostic': '诊断信息',
  'view.cardStatus': '查看状态',
  'view.cardFailureNotApproved': '未获授权；请在应用管理中批准后刷新。',
  'view.cardFailureUndeclared': '该应用未声明这项读取接口。',
  'view.cardFailureClosed': '该应用未向主页开放这项读取。',
  'view.cardFailureDenied': '读取请求被拒绝。',
  'view.cardFailureConfirmation': '读取需要确认，但确认未完成。',
  'view.cardFailureTransport': '没有收到该应用的响应。',
  'view.cardFailureOther': '读取该应用时出错。',
  'view.empty': '还没有内容。',
  'view.unavailable': '暂不可用',
  'view.readFailed': '读取失败，稍后再试。',
  'view.inbox': '收件箱',
  'view.todo': '待办',
  'view.notes': '笔记',
  'view.inboxCounts': '{unread} 条未读',
  'view.inboxSaved': '{saved} 条收藏',
  'view.todoCounts': '{open} 未完成 · {today} 今天到期',
  'view.todoOverdue': '{overdue} 条逾期',
  'view.notesCounts': '{total} 条笔记',
  'view.dueToday': '今天到期',
  'view.overdue': '逾期',
  'view.justNow': '刚刚',
  'view.minutesAgo': '{count} 分钟前',
  'view.hoursAgo': '{count} 小时前',
  'view.inboxName': '信息收件箱',
  'view.todoName': '待办',
  'view.notesName': '笔记',
}

/** English dictionary. */
export const en: Record<keyof typeof zh, string> = {
  'app.name': 'Home',
  'app.description': 'An overview of every application and what just changed.',
  'view.overview': 'Overview',
  'view.activity': 'Recent changes',
  'view.activityEmpty': 'Nothing new right now.',
  'view.activityLine': '{app} · {count} new items',
  'view.activityOne': '{app} · 1 new item',
  'view.open': 'Open',
  'view.loading': 'Reading…',
  'view.notRead': 'Not read',
  'view.retry': 'Retry',
  'view.refresh': 'Refresh',
  'view.refreshing': 'Refreshing…',
  'view.updatedAt': 'Updated {time}',
  'view.diagnostic': 'Diagnostics',
  'view.cardStatus': 'View status',
  'view.cardFailureNotApproved': 'Not approved; approve this app in application management, then refresh.',
  'view.cardFailureUndeclared': 'The app does not declare this read.',
  'view.cardFailureClosed': 'The app does not expose this read to Home.',
  'view.cardFailureDenied': 'The read was refused.',
  'view.cardFailureConfirmation': 'The read needed a confirmation that did not finish.',
  'view.cardFailureTransport': 'No response from the app.',
  'view.cardFailureOther': 'Reading this app failed.',
  'view.empty': 'Nothing here yet.',
  'view.unavailable': 'Unavailable',
  'view.readFailed': 'Could not read; try again later.',
  'view.inbox': 'Inbox',
  'view.todo': 'Todo',
  'view.notes': 'Notes',
  'view.inboxCounts': '{unread} unread',
  'view.inboxSaved': '{saved} saved',
  'view.todoCounts': '{open} open · {today} due today',
  'view.todoOverdue': '{overdue} overdue',
  'view.notesCounts': '{total} notes',
  'view.dueToday': 'Due today',
  'view.overdue': 'Overdue',
  'view.justNow': 'just now',
  'view.minutesAgo': '{count} min ago',
  'view.hoursAgo': '{count} h ago',
  'view.inboxName': 'Inbox',
  'view.todoName': 'Todo',
  'view.notesName': 'Notes',
}

/** Every key this page may translate. */
export type HomeKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Home page copy. */
    'home': HomeKey
  }
}
