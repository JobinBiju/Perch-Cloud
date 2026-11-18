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

## Storage

Workers KV, one key per book per home: `<hash>:pos:<book>`, with the position in the key's metadata so that listing needs no further reads. KV is eventually consistent, which is acceptable for reading positions: two devices saving the same book within the same few seconds could briefly disagree.

## Licence

[GNU GPL v3](LICENSE), the same as Perch OS.
