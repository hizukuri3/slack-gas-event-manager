/**
 * QuizRepository.gs
 * 問題一覧スプレッドシートの読み書き。
 * 1行目はヘッダー。出題順は行の並び順（管理者が事前にシャッフル済み）であり、
 * システム側でのランダム化は行わない。
 */

/**
 * 未出題の先頭行を1件取得する。
 * データ不正（問題文が空／画像ありなのに画像ファイルIDが空／画像取得失敗）や
 * 72問完了時はここでログに残し、呼び出し元には null を返して
 * 「その回は投稿しない」という振る舞いに統一する。
 */
function getNextQuestion_(config) {
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(SHEET_QUIZ);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) { // 0行目はヘッダー
    const row = values[i];
    const posted = row[COL.POSTED];
    if (posted === true || posted === 'TRUE') continue;

    const rowNumber = i + 1; // シート上の実際の行番号（1始まり）
    const number = String(row[COL.NUMBER] || '').trim();
    const text = String(row[COL.TEXT] || '').trim();
    const hasImage = row[COL.HAS_IMAGE] === true || row[COL.HAS_IMAGE] === 'TRUE';
    const imageFileId = String(row[COL.IMAGE_FILE_ID] || '').trim();

    if (!text) {
      console.error(rowNumber + '行目: 問題文が空です。今回の投稿を見送ります。');
      return null;
    }
    if (hasImage && !imageFileId) {
      console.error(rowNumber + '行目: 画像ありなのに画像ファイルIDが空です。今回の投稿を見送ります。');
      return null;
    }

    let imageBlob = null;
    if (hasImage) {
      try {
        imageBlob = DriveApp.getFileById(imageFileId).getBlob();
      } catch (err) {
        console.error(rowNumber + '行目: 画像の取得に失敗しました（fileId: ' + imageFileId + '）: ' + err);
        return null;
      }
    }

    return { rowNumber: rowNumber, number: number, text: text, hasImage: hasImage, imageBlob: imageBlob };
  }

  console.log('未出題の問題がありません。出題完了しました。');
  return null;
}

/** 指定行を出題済みにする（POSTED=TRUE、POSTED_ATに現在日時、MESSAGE_TSに投稿のts） */
function markAsPosted_(config, rowNumber, messageTs) {
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(SHEET_QUIZ);
  sheet.getRange(rowNumber, COL.POSTED + 1).setValue(true);
  sheet.getRange(rowNumber, COL.POSTED_AT + 1).setValue(new Date());
  if (messageTs) {
    // tsは数値に変換されないよう文字列として保存する
    sheet.getRange(rowNumber, COL.MESSAGE_TS + 1).setNumberFormat('@').setValue(String(messageTs));
  }
}

/** 投稿メッセージのtsから問題を探す。見つからなければ null */
function findQuestionByTs_(spreadsheet, messageTs) {
  const values = spreadsheet.getSheetByName(SHEET_QUIZ).getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][COL.MESSAGE_TS] || '').trim() === String(messageTs)) {
      return {
        rowNumber: i + 1,
        number: String(values[i][COL.NUMBER] || '').trim(),
        postedAt: values[i][COL.POSTED_AT]
      };
    }
  }
  return null;
}
