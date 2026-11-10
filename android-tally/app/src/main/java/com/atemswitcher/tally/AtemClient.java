package com.atemswitcher.tally;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * Just enough of the ATEM protocol (UDP 9910) to follow tally straight from the ATEM, with no PC:
 * program (PrgI), preview (PrvI), transition (TrPs) and input names (InPr) of M/E 1.
 * Same packet handling as atem-connection: hello, then ack every packet in order.
 */
final class AtemClient {
    interface Listener {
        /** connected = the ATEM is answering; names = HDMI inputs by number */
        void onTally(boolean connected, int program, int preview, boolean inTransition, Map<Integer, String> names);
    }

    private static final int PORT = 9910;
    private static final int MAX_PACKET_ID = 1 << 15;
    private static final int FLAG_ACK_REQUEST = 0x01, FLAG_NEW_SESSION = 0x02, FLAG_ACK_REPLY = 0x10;
    private static final byte[] HELLO = {
        0x10, 0x14, 0x53, (byte) 0xab, 0, 0, 0, 0, 0, 0x3a, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0
    };

    private final String host;
    private final Listener listener;

    private int program = -1, preview = -1;
    private boolean inTransition;
    private final Map<Integer, String> names = new TreeMap<>();

    AtemClient(String host, Listener listener) {
        this.host = host;
        this.listener = listener;
    }

    /** answers a hello? (used by Find) */
    static boolean probe(InetAddress addr, int timeoutMs) {
        try (DatagramSocket s = new DatagramSocket()) {
            s.setSoTimeout(timeoutMs);
            s.send(new DatagramPacket(HELLO, HELLO.length, addr, PORT));
            byte[] buf = new byte[64];
            s.receive(new DatagramPacket(buf, buf.length));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** one connection: returns when the ATEM stops answering or keepGoing turns false */
    void connectOnce(java.util.function.BooleanSupplier keepGoing) {
        try (DatagramSocket s = new DatagramSocket()) {
            InetAddress addr = InetAddress.getByName(host);
            s.setSoTimeout(500);
            session(s, addr, keepGoing);
        } catch (Exception ignored) {
        }
        listener.onTally(false, program, preview, inTransition, names);
    }

    private void session(DatagramSocket s, InetAddress addr, java.util.function.BooleanSupplier keepGoing) throws Exception {
        byte[] buf = new byte[2048];
        int sessionId = 0x53ab;
        int lastId = -1;
        boolean established = false;
        long lastHeard = System.currentTimeMillis(), lastHello = 0;
        Map<Integer, byte[]> ahead = new HashMap<>();
        s.send(new DatagramPacket(HELLO, HELLO.length, addr, PORT));
        lastHello = System.currentTimeMillis();

        while (keepGoing.getAsBoolean()) {
            long now = System.currentTimeMillis();
            if (now - lastHeard > 5000) return; // the ATEM went quiet: start again
            if (!established && now - lastHello > 1000) {
                s.send(new DatagramPacket(HELLO, HELLO.length, addr, PORT));
                lastHello = now;
            }
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            try {
                s.receive(p);
            } catch (SocketTimeoutException e) {
                continue;
            }
            int len = p.getLength();
            if (len < 12 || (u16(buf, 0) & 0x07ff) != len) continue;
            lastHeard = System.currentTimeMillis();
            int flags = (buf[0] & 0xff) >> 3;
            sessionId = u16(buf, 2);
            int remoteId = u16(buf, 10);

            if ((flags & FLAG_NEW_SESSION) != 0) {
                established = true;
                lastId = remoteId;
                ahead.clear();
                ack(s, addr, sessionId, remoteId);
                continue;
            }
            if (!established || (flags & FLAG_ACK_REQUEST) == 0 || remoteId >= MAX_PACKET_ID) continue;

            int distance = (remoteId - lastId + MAX_PACKET_ID) % MAX_PACKET_ID;
            if (distance == 1) {
                lastId = remoteId;
                boolean changed = commands(buf, 12, len);
                // packets that came early, now in order
                byte[] next;
                while ((next = ahead.remove((lastId + 1) % MAX_PACKET_ID)) != null) {
                    lastId = (lastId + 1) % MAX_PACKET_ID;
                    changed |= commands(next, 0, next.length);
                }
                ack(s, addr, sessionId, lastId);
                if (changed) listener.onTally(true, program, preview, inTransition, names);
            } else if (distance > 1 && distance <= 256) {
                byte[] copy = new byte[len - 12];
                System.arraycopy(buf, 12, copy, 0, copy.length);
                ahead.put(remoteId, copy);
            } else {
                ack(s, addr, sessionId, lastId); // a resend of one we already have
            }
        }
    }

    private static void ack(DatagramSocket s, InetAddress addr, int sessionId, int packetId) throws Exception {
        byte[] b = new byte[12];
        int head = (FLAG_ACK_REPLY << 11) | 12;
        b[0] = (byte) (head >> 8);
        b[1] = (byte) head;
        b[2] = (byte) (sessionId >> 8);
        b[3] = (byte) sessionId;
        b[4] = (byte) (packetId >> 8);
        b[5] = (byte) packetId;
        s.send(new DatagramPacket(b, b.length, addr, PORT));
    }

    /** reads the commands in one packet; true when tally or names changed */
    private boolean commands(byte[] b, int from, int to) {
        boolean changed = false;
        int i = from;
        while (i + 8 <= to) {
            int len = u16(b, i);
            if (len < 8 || i + len > to) break;
            String name = new String(b, i + 4, 4, StandardCharsets.US_ASCII);
            int d = i + 8;
            switch (name) {
                case "PrgI":
                    if ((b[d] & 0xff) == 0 && program != u16(b, d + 2)) { program = u16(b, d + 2); changed = true; }
                    break;
                case "PrvI":
                    if ((b[d] & 0xff) == 0 && preview != u16(b, d + 2)) { preview = u16(b, d + 2); changed = true; }
                    break;
                case "TrPs":
                    if ((b[d] & 0xff) == 0 && inTransition != (b[d + 1] == 1)) { inTransition = b[d + 1] == 1; changed = true; }
                    break;
                case "InPr":
                    if (len >= 8 + 33 && b[d + 32] == 0) { // internal port type 0 = a real input
                        String shortName = text(b, d + 22, 4), longName = text(b, d + 2, 20);
                        names.put(u16(b, d), shortName.isEmpty() ? longName : shortName);
                        changed = true;
                    }
                    break;
                default:
            }
            i += len;
        }
        return changed;
    }

    private static String text(byte[] b, int off, int max) {
        int n = 0;
        while (n < max && b[off + n] != 0) n++;
        return new String(b, off, n, StandardCharsets.UTF_8).trim();
    }

    private static int u16(byte[] b, int off) {
        return ((b[off] & 0xff) << 8) | (b[off + 1] & 0xff);
    }

}
