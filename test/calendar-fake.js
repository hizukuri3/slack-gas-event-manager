// カレンダー操作のテストで共通に使う偽物（実際のカレンダーは使わず、呼び出しを記録する）
function fakeCalendar(opts) {
  opts = opts || {};
  const log = [];
  let seq = 0;
  const sleeps = [];
  const Calendar = {
    Events: {
      insert: () => {
        if (opts.insert) opts.insert(log);
        seq += 1;
        log.push('insert');
        return { id: 'new' + seq, htmlLink: 'https://calendar/new' + seq, hangoutLink: 'https://meet.google.com/m' + seq };
      },
      patch: (resource, calendarId, id) => {
        const kind = 'description' in resource ? 'description' : 'summary';
        if (opts.patch) opts.patch(kind, id, log);
        log.push('patch:' + kind + ':' + id);
        return {};
      },
      remove: (calendarId, id) => {
        if (opts.remove) opts.remove(id);
        log.push('remove:' + id);
      }
    }
  };
  const Utilities = {
    formatDate: () => '2099-01-05T10:00:00+09:00',
    sleep: (ms) => { sleeps.push(ms); }
  };
  return { Calendar, Utilities, log, sleeps };
}

const rateLimit = () => new Error('GoogleJsonResponseException: API call to calendar.events.patch failed with error: Rate Limit Exceeded');
const deleted = () => new Error('GoogleJsonResponseException: API call to calendar.events.patch failed with error: Resource has been deleted');


module.exports = { fakeCalendar, rateLimit, deleted };
