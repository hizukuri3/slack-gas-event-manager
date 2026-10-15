/**
 * VcRoom.gs
 * Discord VC の在庫台帳（VCルームリスト）の読み込みと、イベントへの部屋の割り当て。
 *
 * Discord側にはそもそも「予約」という概念が無く、VCは誰でもいつでも入れる。
 * ここでやっているのは札を立てることであって、入室を止めることはできない。
 * （権限で締め出すにはBotトークンでのAPI操作が要り、この構成では持たない方針）
 *
 * 予約が成立する唯一の場所はフォーム送信時（onFormSubmit）で、あそこは
 * スクリプトロックの中なので、同時送信でも部屋が二重取りされることはない。
 * 一方フォーム記入中に空き状況を出すことはGoogleフォームの仕様上できないため、
 * 「埋まっている部屋を選んで送信 → 差し戻し」は原理的に無くせない。
 */

/** 開催形式が Discord VC かどうか（EVENT_FORMATS の値と完全一致で判定する） */
function isDiscordVc_(format) {
  return String(format).trim() === EVENT_FORMATS.DISCORD;
}

/**
 * 定員が未入力のVC部屋に当てる収容人数。
 * 通常のDiscordボイスチャンネルは99人が上限（設定可能な最大値でもある）なので、
 * 「特に書かれていない部屋」はその上限まで入るものとして扱う。
 * ステージチャンネル等で99人を超える部屋は、シートに実数を書いてもらう。
 */
const VC_ROOM_DEFAULT_CAPACITY = 99;

/**
 * VCルームリストを行順のまま読み込む（無効な行と、名前かURLが欠けた行は除く）。
 * ★ 行順は優先順位そのもの ★ おまかせの自動割り当てが上から探すため、
 * ここで並べ替えては絶対にいけない。
 */
function listVcRooms_(config) {
  const sheet = SpreadsheetApp.openById(config.managementSpreadsheetId)
    .getSheetByName(SHEET_VC_ROOMS);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  const rooms = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const name = String(row[VC_ROOM_COL.NAME] || '').trim();
    const url = String(row[VC_ROOM_COL.URL] || '').trim();
    // 名前かURLが欠けている行は予約に使えない。書きかけの行を拾わないよう飛ばす
    if (!name || !url) continue;
    if (!isEnabledFlag_(row[VC_ROOM_COL.ENABLED])) continue;

    const capacity = Number(row[VC_ROOM_COL.CAPACITY]);
    rooms.push({
      name: name,
      url: url,
      capacity: capacity > 0 ? capacity : VC_ROOM_DEFAULT_CAPACITY,
      owner: normalizeSlackUserId_(row[VC_ROOM_COL.OWNER])
    });
  }
  return rooms;
}

/**
 * フォームの「VC部屋」設問に並べる選択肢を組み立てる。
 * 先頭は必ず「おまかせ」。部屋が1件も無くても選択肢が空にならないようにするため
 * （FormApp は空の選択肢を受け付けない）でもあり、迷ったらこれを選べば
 * 確保漏れが起きない、という既定の道を先頭に置くためでもある。
 */
function vcRoomChoiceValues_(config) {
  return [VC_ROOM_AUTO].concat(
    listVcRooms_(config).map(function (room) { return room.name; })
  );
}

/** 2つの時間帯が重なるか（境界が接するだけは重なりとみなさない） */
function timeRangesOverlap_(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * 指定の時間帯に既に押さえられているVC部屋の名前を返す。
 * 中止済みのイベントは枠を離すので数えない。
 *
 * @param {string} excludeEventId 自分自身を除くためのイベントID（編集時に使う）。
 *   これが無いと、日時を変えずに内容だけ直したときに「自分の部屋が埋まっている」
 *   と判定されて自分の予約に弾かれる。
 * @return {string[]} 使用中の部屋名
 */
function vcRoomsInUse_(config, start, end, excludeEventId) {
  return filterEvents_(config, function (ev) {
    if (ev.eventId === excludeEventId) return false;
    if (!ev.vcRoom) return false;
    if (isCancelledStatus_(ev.status)) return false;
    return timeRangesOverlap_(start, end, ev.start, ev.end);
  }).map(function (ev) { return ev.vcRoom; });
}

/**
 * イベントにVC部屋を割り当てる。
 *
 * 名指しとおまかせで、埋まっていたときの振る舞いが違う。
 * 名指しは代わりの部屋を勝手に当てない（指名した意味が消えるため）。
 * 名指しは所有者も見ない（他人の個人VCも指名できる。借りる運用を残すため）。
 * おまかせは空いている部屋を順に探し、大部屋まで含めて全滅したときだけ差し戻す。
 *
 * @param {Object} ev イベント（start / end / capacity / organizer / eventId を使う）
 * @param {string} requested フォームで選ばれたVC部屋名。VC_ROOM_AUTO ならおまかせ
 * @return {{room: ?Object, errors: string[]}} room が null ならエラー文言が入る
 */
function assignVcRoom_(config, ev, requested) {
  const rooms = listVcRooms_(config);
  if (rooms.length === 0) {
    return {
      room: null,
      errors: ['「' + SHEET_VC_ROOMS + '」シートに使えるVC部屋が1件も登録されていません。' +
        '運営にお問い合わせください。']
    };
  }

  const inUse = vcRoomsInUse_(config, ev.start, ev.end, ev.eventId);
  const fits = function (room) { return room.capacity >= ev.capacity; };
  const isFree = function (room) { return inUse.indexOf(room.name) === -1; };

  // ---- 名指し ----
  if (requested && requested !== VC_ROOM_AUTO) {
    const named = rooms.find(function (room) { return room.name === requested; });
    if (!named) {
      return {
        room: null,
        errors: ['指定されたVC部屋「' + requested + '」が見つかりません。' +
          'リストから削除されたか、「無効」になっている可能性があります。' +
          '別の部屋か「' + VC_ROOM_AUTO + '」を選んで再送信してください。']
      };
    }
    if (!fits(named)) {
      return {
        room: null,
        errors: ['「' + named.name + '」の収容人数は' + named.capacity + '名までのため、' +
          '定員' + ev.capacity + '名のイベントには使えません。' +
          'より大きい部屋か「' + VC_ROOM_AUTO + '」を選んで再送信してください。']
      };
    }
    if (!isFree(named)) {
      return {
        room: null,
        errors: ['「' + named.name + '」は' + formatDateRange_(ev.start, ev.end) +
          ' に別のイベントが予約済みです。\n' + availableRoomsNotice_(rooms, fits, isFree)]
      };
    }
    return { room: named, errors: [] };
  }

  // ---- おまかせ ----
  // 1. 主催者自身の部屋があればそれを最優先にする。師匠が少人数の会を開くときに
  //    毎回同じ部屋になり、弟子が場所を覚えていられる
  const own = rooms.find(function (room) {
    return room.owner && room.owner === ev.organizer && fits(room) && isFree(room);
  });
  if (own) return { room: own, errors: [] };

  // 2. 所有者のいない共有部屋を行順で。大部屋を下に置いておけば最後の砦になる
  const shared = rooms.find(function (room) {
    return !room.owner && fits(room) && isFree(room);
  });
  if (shared) return { room: shared, errors: [] };

  // ---- 確保できなかった ----
  // 「そもそも入る部屋が無い」と「あるが埋まっている」は原因も対処も違うので分ける
  const bigEnough = rooms.filter(function (room) { return !room.owner && fits(room); });
  if (bigEnough.length === 0) {
    const largest = rooms.reduce(function (max, room) {
      return room.capacity > max ? room.capacity : max;
    }, 0);
    return {
      room: null,
      errors: ['定員' + ev.capacity + '名を収容できるVC部屋が登録されていません' +
        '（現在の最大は' + largest + '名）。定員を見直すか、運営に部屋の追加を依頼してください。']
    };
  }
  return {
    room: null,
    errors: [formatDateRange_(ev.start, ev.end) + ' は、定員' + ev.capacity +
      '名を収容できるVC部屋がすべて予約済みです。日時を変えて再送信してください。']
  };
}

/** 差し戻し文面に添える「いま空いている部屋」の案内を組み立てる */
function availableRoomsNotice_(rooms, fits, isFree) {
  const names = rooms
    .filter(function (room) { return !room.owner && fits(room) && isFree(room); })
    .map(function (room) { return room.name; });
  if (names.length === 0) {
    return 'その時間に空いている部屋もありません。日時を変えて再送信してください。';
  }
  return 'その時間に空いている部屋: ' + names.join(' / ') + '\n' +
    'いずれかを選ぶか「' + VC_ROOM_AUTO + '」にして再送信してください。';
}
