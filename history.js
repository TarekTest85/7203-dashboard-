// Lookup history. Each user-initiated Load / Refresh / horizon change
// saves a snapshot to localStorage so the user can revisit prior runs.
(function () {
  var KEY = "elm7203.history";
  var MAX = 50;

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function write(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr.slice(-MAX))); }
    catch (e) { /* ignore quota errors */ }
  }

  // Coalesce: if the last entry has the same symbol + horizon + lastDate,
  // overwrite it instead of appending — keeps the list tidy when the user
  // toggles horizon repeatedly on the same data.
  function add(entry) {
    var arr = read();
    var last = arr[arr.length - 1];
    if (last &&
        last.symbol === entry.symbol &&
        last.horizonWeeks === entry.horizonWeeks &&
        last.lastDate === entry.lastDate) {
      arr[arr.length - 1] = entry;
    } else {
      arr.push(entry);
    }
    write(arr);
    return entry;
  }

  function remove(id) {
    var arr = read().filter(function (e) { return e.id !== id; });
    write(arr);
  }

  function clear() { write([]); }

  function getAll() { return read().slice().reverse(); } // newest first

  window.HistoryStore = { add: add, remove: remove, clear: clear, getAll: getAll };
})();
