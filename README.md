# Perch Cloud

The sync backend for [Perch OS](https://github.com/JobinBiju/Perch-OS) and [Perch OS E-Paper](https://github.com/JobinBiju/Perch-OS-E-Paper): a Cloudflare Worker that lets the devices of one owner share where they are in each book. It runs on Cloudflare's free tier.

There are no accounts. Every device of one owner holds the same long random **home key**. The Worker stores everything under a hash of that key, so one home never sees another's data, and the key itself is never stored.

## Deploy your own

```
bunx wrangler login
bunx wrangler kv namespace create PERCH    # put the id it prints into wrangler.toml
bunx wrangler deploy
```

`deploy` prints the Worker's address. Give that address and a home key to each device: in a device's portal choose **Set up cloud sync**, press **Generate** for a key and save, which sends both to every paired device. Over USB the same is `sync <address> <key>` on the serial console.

## The contract

Both firmwares follow this. Change it here first, then in each firmware.

### Authentication

Every request carries the home key, as `Authorization: Bearer <key>` or `?k=<key>`. A key is 24 to 128 characters. Without one the answer is `401`.

### Endpoints

| Request | Body | Answer |
|---|---|---|
| `PUT /v1/pos/<book>` | a position | `{"stored": true, "pos": …}`, or `{"stored": false, "pos": <the newer one kept>}` |
| `GET /v1/pos/<book>` | | the newest position, or `{}` when none is stored |
| `GET /v1/pos` | | `{"<book>": position, …}` for every book of this home |

`<book>` is the book's file name on the devices (`[A-Za-z0-9._-]`, up to 64 characters), for example `homo-deus-a-brief-history-of-tomorrow.txt`. The portal's converter derives it from the title, so the same EPUB gets the same name on every device.

### A position

```json
{"ch": 1, "rel": 121880, "len": 158592, "pct": 11, "t": 1794980583, "dev": "Perch"}
```

| Field | Meaning |
|---|---|
| `ch` | chapter index, counting the `\x01` chapter markers in the book text from 0 |
| `rel` | bytes from the start of that chapter's text to the start of the page being read |
| `len` | that chapter's length in bytes on the sending device |
| `pct` | percent through the whole book, for display only |
| `t` | when this position was read, epoch seconds |
| `dev` | the sending device's name, shown as "Synced from …" |

Positions are places in the text, never page numbers: each device paginates for its own screen and opens the page that contains the place. `len` is there because two conversions of one book can differ by a few bytes; the receiver scales `rel` by its own chapter length over `len`.

### Rules for devices

- **Newest wins.** The Worker keeps a position only if its `t` is later than the stored one. `t` is the time the reader last *moved*, not the time of the request.
- **Push** when the reader is left, when the display sleeps, and before light or deep sleep. Do not push a position that has not changed since the last push.
- **Pull** when a book is opened. If the answer's `t` is later than the local position's, go there, take over its `t`, and tell the reader which device it came from.
- **Opening is not reading.** A device that opens at a synced position and closes without turning a page must not push: its page start may be a little earlier than the sender's, and pushing it would walk the position backwards.
- **No clock, no sync.** A device that does not know the time yet neither pushes nor applies.

### Notes: bookmarks and highlights

| Request | Body | Answer |
|---|---|---|
| `POST /v1/notes/<book>` | `{"items": [...], "dev": "Perch"}`: every note and tombstone this device holds for the book | `{"items": [...]}`: the merged set, which the device takes as its own |
| `GET /v1/notes/<book>` | | `{"items": [...]}` as stored |
| `GET /v1/notes` | | `{"<book>": [...], ...}`: every book's notes, tombstones left out (for the portal) |

An item is one of:

```json
{"id": 2911046633, "k": "m", "ch": 1, "rel": 121880, "len": 158592, "pct": 11, "t": 1794980583}
{"id": 771204518, "k": "h", "ch": 1, "rel": 4310, "end": 4391, "len": 158592, "pct": 6, "t": 1794980601, "q": "Fiction is not a lie", "n": "Compare with Sapiens", "dev": "Sticky"}
{"id": 2911046633, "del": 1, "t": 1794981200}
```

| Field | Meaning |
|---|---|
| `id` | a random non-zero 32-bit number given when the note is made; it never changes |
| `k` | `"m"` a bookmark (a page: `rel` is its page start), `"h"` a highlight (`rel` to `end`) |
| `ch`, `rel`, `len`, `pct` | as in a position; `end` is the highlight's last byte + 1, in the same chapter |
| `t` | when it was made, or removed, in epoch seconds |
| `del` | `1` marks a tombstone: this note was removed |
| `q` | optional: the highlighted words, or the first words of a bookmarked page, as plain text (up to 600 bytes). Sent by the device that has the book, so the portal can show notes without the book |
| `n` | optional, highlights only: the reader's own note (up to 2000 bytes); `""` when there is none. Written in the portal |
| `dev` | optional: the device (or `"Portal"`) that last changed the item. The Worker fills it from the request's `dev` when a new or changed item has none |

Rules:

- **Merge by id.** For each id the copy with the later `t` wins; on a tie a removal wins. Nothing is lost when two devices add notes while apart.
- **Removing leaves a tombstone.** A device that removes a note keeps `{id, del, t}` and sends it, so the removal reaches the others. The Worker forgets tombstones after 180 days; devices may cap how many they keep.
- **One call both sends and receives.** A device posts its whole set when a book is opened and after it adds or removes a note, then replaces its set with the answer. If it changed a note while the request was out, it discards the answer and posts again.
- **Leaving a field out keeps it.** A changed item without `q` or `n` keeps the stored `q` and `n`, so a device that does not store them never erases them. To clear a note, send `"n": ""`. A device should still send `q` for every item it holds when it has the book open: the Worker adds it to items stored without one.
- **Editing a note** is a change like any other: the item with the new `n` and a later `t`.
- **Overlapping highlights** are merged on the device that makes them, into one new item, with tombstones for the ones it replaced.
- Up to 400 items a book.

## Storage

Workers KV. Positions: one key per book per home, `<hash>:pos:<book>`, with the position in the key's metadata so that listing needs no further reads. Notes: `<hash>:notes:<book>`, a JSON array as the value, written only when a merge changes it. KV is eventually consistent, which is acceptable for reading positions: two devices saving the same book within the same few seconds could briefly disagree.

## Licence

[GNU GPL v3](LICENSE), the same as Perch OS.
