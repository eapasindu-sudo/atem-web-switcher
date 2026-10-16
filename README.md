# ATEM Web Switcher

A landscape web control panel for the Blackmagic **ATEM Mini Extreme** (works with other ATEM models too).

- **PROGRAM** row: the live source is **red**
- **PREVIEW** row: the next source is **green**
- Big buttons for inputs **1–8** on both rows
- **CUT** and **AUTO** buttons
- **T-bar** you can drag with a finger or mouse
- Buttons stay in sync with the switcher, so if someone presses a button on the ATEM itself, the page updates too

## Windows installer (easiest)

**Download:** [ATEM-Switcher-Setup.exe](https://github.com/eapasindu-sudo/atem-web-switcher/raw/main/download/ATEM-Switcher-Setup.exe)

Run `ATEM-Switcher-Setup.exe`. It installs **ATEM Switcher** with Start menu and desktop shortcuts,
and allows it through Windows Firewall so phones can connect. No Node.js needed.

Opening ATEM Switcher shows the PC control window:

- **ATEM switcher**: connected or not, the model, and the live Program/Preview inputs
- **ATEM IP address**: type a new IP and press Connect (it is remembered)
- **Open on your phone**: a QR code. Scan it with the iPhone/Android camera and the switcher opens, already connected
- **Connected phones**: every phone/tablet using the switcher right now
- **Input buttons**: Auto (matches the ATEM's HDMI inputs) or a fixed 4 to 8 buttons on the phones
- **Updates**: checks GitHub for a newer version and installs it with one click; phones reload by themselves
- **Stop server**: stops the switcher (closing the window keeps it running in the background)
- **Sony cameras**: add FX3/FX30/FX6 or A7 IV/A7S III (and other Sony bodies with PC Remote) over Wi-Fi

### Sony camera control (CCU)

Phones get a **CCU** tab next to **SWITCHER**. Pick a camera and change **iris, shutter (or angle), ISO/EI,
white balance and Kelvin, ND (FX6), focus** and start/stop **REC**. Tap a value to see every option,
or use − and +. If a camera is linked to an ATEM input, its tab shows red/green tally and
**Follow preview** jumps to the camera on preview.

Camera setup (menu names from FX3/A7 IV):
1. Network, Wi-Fi: join the same Wi-Fi as the PC.
2. Network, Cnct./PC Remote, PC Remote Function: PC Remote **On**.
3. Access Authen. Settings **On**; the user name and password are in Access Authen. Info.
4. On the PC window, Sony cameras, **Add camera** (or **Find cameras on the network**), enter the IP and password.

Sony control uses the Sony Camera Remote SDK (runtime files in `sony\`). The SDK itself is not in this repository;
to rebuild that part: `SONY_SDK=/path/to/RemoteCli build/sony-bridge/build-mingw.sh` before `build/build-windows.sh`.

On iPhone, tap Share then **Add to Home Screen** once, and it opens full screen like an app after that.
Settings and a log file are kept in `%APPDATA%\ATEM Switcher`.

To rebuild the installer (on Linux): `npm install`, then `build/build-windows.sh`.

## Why there is a small server

Web browsers cannot talk to an ATEM directly (the ATEM uses UDP port 9910, which browsers can't open).
So this app runs a small Node.js server on a computer on the same network. The server talks to the ATEM,
and your browser (phone, tablet, laptop) talks to the server.

```
Phone / Tablet / Laptop  ──Wi-Fi──>  Computer running this app  ──LAN──>  ATEM Mini Extreme
       (browser)                       (node server.js)                    (IP e.g. 192.168.1.240)
```

## How to run

1. Install **Node.js 18 or newer** from https://nodejs.org (once only).
2. Open a terminal / command prompt in this folder and run:

   ```
   npm install
   npm start
   ```

3. The terminal shows addresses like:

   ```
   ATEM Web Switcher running:
     http://localhost:3000
     http://192.168.1.50:3000  (phones/tablets on the same Wi-Fi)
   ```

4. Open one of those addresses in a browser. On a phone or tablet use the second one.
5. Type the ATEM's IP address at the top and press **Connect**. The status turns green when connected.
   The IP is saved, so next time it connects automatically.

To find the ATEM's IP: open **ATEM Software Control** or **ATEM Setup** → Network settings.
The computer running the app must be on the same network as the ATEM.

To use a different port: `PORT=8080 npm start` (Windows PowerShell: `$env:PORT=8080; npm start`).

## Using it

| Action | Touch / mouse | Keyboard |
|---|---|---|
| Put a source on preview | tap it on the green PREVIEW row | `1`–`8` |
| Put a source straight on air | tap it on the red PROGRAM row | `Shift` + `1`–`8` |
| Cut | **CUT** | `Space` |
| Auto transition | **AUTO** | `Enter` |
| Manual transition | drag the **T-bar** all the way to the other end | |

The T-bar works like the real lever: push it all the way up to finish a transition, then the next
transition goes back down. Use the ⛶ button for fullscreen. On a phone, turn it sideways (landscape).

## Files

- `server.js` – Node server: connects to the ATEM (using the `atem-connection` library) and to browsers (WebSocket)
- `public/` – the web page (`index.html`, `style.css`, `app.js`)
- `config.json` – created automatically, remembers the last ATEM IP
