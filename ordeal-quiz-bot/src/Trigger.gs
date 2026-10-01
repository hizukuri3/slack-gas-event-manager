/**
 * Trigger.gs
 * エントリポイント。postDailyQuiz() を時間主導トリガーから実行する。
 * setupTriggers() を1度手動実行してトリガーを登録すること。
 */

/**
 * 毎日の定期投稿トリガーを登録する。
 * 初回セットアップ時と、設定シートの POST_HOUR を変えたときに手動実行する。
 */
function setupTriggers() {
  const hour = Number(getConfig_().settings.POST_HOUR);
  const postHour = (hour >= 0 && hour <= 23) ? Math.floor(hour) : 9;

  // 二重登録を防ぐため既存の同名トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'postDailyQuiz') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('postDailyQuiz')
    .timeBased()
    .everyDays(1)
    .atHour(postHour)
    .create();
  console.log('postDailyQuiz を毎日 ' + postHour + ' 時台に登録しました。');
}

/**
 * 未出題の問題を1問Slackに投稿する。設定シートの SKIP_WEEKENDS が TRUE なら土日は投稿しない。
 * GASの時間主導トリガーには「平日のみ」の指定方法がないため、
 * 毎日トリガーを登録した上でここで曜日判定してスキップする。
 */
function postDailyQuiz() {
  const day = new Date().getDay(); // 0:日, 6:土
  if ((day === 0 || day === 6) && isTrue_(getConfig_().settings.SKIP_WEEKENDS)) return;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.error('ロック取得に失敗しました。今回の実行をスキップします。');
    return;
  }

  try {
    const config = getConfig_();
    const question = getNextQuestion_(config);
    if (!question) return; // 出題完了、またはデータ不正（QuizRepository.gs側でログ済み）

    const settings = config.settings;
    const text = buildMessageText_(settings, question);
    const messageTs = question.hasImage
      ? postImage_(config, settings, text, question.imageBlob)
      : postText_(config, settings, text);

    if (messageTs) {
      markAsPosted_(config, question.rowNumber, messageTs);
    } else {
      console.error('Slackへの投稿に失敗しました（' + question.number + '）。出題済みにはしません。');
    }
  } finally {
    lock.releaseLock();
  }
}
