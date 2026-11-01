package com.robfulcher.aoe2companion;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Local Wi-Fi play for AOSiege, without typing IP addresses.
 *
 * Host: opens a TCP port and advertises it on the network with Android's
 * service discovery (NSD / mDNS, type "_aosiege._tcp"). Join: browses for
 * those services and lists them; picking one connects straight to it.
 *
 * Messages are lines of text (JSON from the app), one per line.
 * Events to JavaScript: peer {peer, state: join|leave}, message {peer?, data},
 * found {id, name, host, port}, lost {id}, closed {}.
 *
 * iPhones (and any browser) on the same Wi-Fi: while hosting, the phone also runs a small
 * web server (port 8790). Opening http://<this phone>:8790/ in Safari loads the app from
 * this phone, its game graphics through this phone (downloaded once and kept), and joins
 * games through a WebSocket at /ws that speaks the same messages as the development relay.
 * Browsers that join look like any other player to the game.
 */
@CapacitorPlugin(name = "Lan")
public class LanPlugin extends Plugin {
    private static final String TAG = "AOSiegeLan";
    private static final String SERVICE_TYPE = "_aosiege._tcp.";

    private NsdManager nsd;
    private WifiManager.MulticastLock multicastLock;

    // Hosting
    private ServerSocket server;
    private NsdManager.RegistrationListener registration;
    private final Map<String, Conn> peers = new ConcurrentHashMap<>();
    private final AtomicInteger nextPeer = new AtomicInteger(1);

    // Joining
    private Peer client;

    // Discovery
    private NsdManager.DiscoveryListener discovery;
    private final ArrayDeque<NsdServiceInfo> toResolve = new ArrayDeque<>();
    private boolean resolving = false;

    private final ExecutorService io = Executors.newCachedThreadPool();

    /** A joined player: over a plain connection (Android) or a WebSocket (a browser). */
    private abstract static class Conn {
        final String id;
        final Socket socket;
        final ExecutorService writer = Executors.newSingleThreadExecutor();

        Conn(String id, Socket socket) { this.id = id; this.socket = socket; }

        abstract void send(String line);

        void close() {
            try { socket.close(); } catch (Exception ignored) { }
            writer.shutdownNow();
        }
    }

    /** One connection: its socket, a writer used from one thread at a time, and its id. */
    private static class Peer extends Conn {
        final BufferedWriter out;

        Peer(String id, Socket socket) throws Exception {
            super(id, socket);
            this.out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        }

        @Override
        void send(String line) {
            writer.execute(() -> {
                try {
                    out.write(line);
                    out.write('\n');
                    out.flush();
                } catch (Exception e) {
                    Log.w(TAG, "send failed: " + e);
                }
            });
        }

    }

    @Override
    public void load() {
        nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
    }

    private void lockMulticast() {
        if (multicastLock != null) return;
        WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi == null) return;
        multicastLock = wifi.createMulticastLock("aosiege");
        multicastLock.setReferenceCounted(false);
        multicastLock.acquire();
    }

    private void unlockMulticast() {
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        multicastLock = null;
    }

    // ---------------- Hosting ----------------

    /** Start a game: listen on a free port and advertise it under the given name. */
    @PluginMethod
    public void host(PluginCall call) {
        String name = call.getString("name", "AOSiege game");
        stopHosting();
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(0));
        } catch (Exception e) {
            call.reject("Couldn't open a port: " + e.getMessage());
            return;
        }
        int port = server.getLocalPort();
        io.execute(this::acceptLoop);

        lockMulticast();
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName(name);
        info.setServiceType(SERVICE_TYPE);
        info.setPort(port);
        registration = new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo i) { Log.i(TAG, "advertising " + i.getServiceName()); }
            @Override public void onRegistrationFailed(NsdServiceInfo i, int err) { Log.w(TAG, "advertise failed " + err); }
            @Override public void onServiceUnregistered(NsdServiceInfo i) { }
            @Override public void onUnregistrationFailed(NsdServiceInfo i, int err) { }
        };
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
        } catch (Exception e) {
            Log.w(TAG, "register failed: " + e);
        }
        gamePort = port;
        gameName = name;
        startWeb();
        JSObject ret = new JSObject();
        ret.put("port", port);
        String ip = wifiAddress();
        if (web != null && ip != null) ret.put("web", "http://" + ip + ":" + web.getLocalPort() + "/");
        call.resolve(ret);
    }

    private void acceptLoop() {
        ServerSocket s = server;
        while (s != null && !s.isClosed()) {
            try {
                Socket socket = s.accept();
                socket.setTcpNoDelay(true);
                String id = "p" + nextPeer.getAndIncrement();
                Peer peer = new Peer(id, socket);
                peers.put(id, peer);
                JSObject ev = new JSObject();
                ev.put("peer", id);
                ev.put("state", "join");
                notifyListeners("peer", ev);
                io.execute(() -> readLoop(peer, true));
            } catch (Exception e) {
                if (s.isClosed()) return;
                Log.w(TAG, "accept: " + e);
            }
        }
    }

    /** Stop advertising (keep connections), e.g. once the game starts. */
    @PluginMethod
    public void stopAdvertising(PluginCall call) {
        unregister();
        call.resolve();
    }

    private void unregister() {
        if (registration != null) {
            try { nsd.unregisterService(registration); } catch (Exception ignored) { }
            registration = null;
        }
    }

    @PluginMethod
    public void stopHost(PluginCall call) {
        stopHosting();
        call.resolve();
    }

    private void stopHosting() {
        unregister();
        if (server != null) {
            try { server.close(); } catch (Exception ignored) { }
            server = null;
        }
        for (Conn p : peers.values()) p.close();
        peers.clear();
        stopWeb();
        if (discovery == null) unlockMulticast();
    }

    @PluginMethod
    public void sendTo(PluginCall call) {
        Conn p = peers.get(call.getString("peer", ""));
        if (p != null) p.send(call.getString("data", ""));
        call.resolve();
    }

    @PluginMethod
    public void broadcast(PluginCall call) {
        String data = call.getString("data", "");
        for (Conn p : peers.values()) p.send(data);
        call.resolve();
    }

    @PluginMethod
    public void kick(PluginCall call) {
        Conn p = peers.remove(call.getString("peer", ""));
        if (p != null) p.close();
        call.resolve();
    }

    // ---------------- Joining ----------------

    /** Look for games on the network. Each one found is resolved to an address and reported. */
    @PluginMethod
    public void discover(PluginCall call) {
        stopDiscovery();
        lockMulticast();
        discovery = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) { }
            @Override public void onDiscoveryStopped(String type) { }
            @Override public void onStartDiscoveryFailed(String type, int err) { Log.w(TAG, "discover failed " + err); }
            @Override public void onStopDiscoveryFailed(String type, int err) { }
            @Override public void onServiceFound(NsdServiceInfo info) {
                if (!info.getServiceType().contains("_aosiege")) return;
                synchronized (toResolve) { toResolve.add(info); }
                resolveNext();
            }
            @Override public void onServiceLost(NsdServiceInfo info) {
                JSObject ev = new JSObject();
                ev.put("id", info.getServiceName());
                notifyListeners("lost", ev);
            }
        };
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
            call.resolve();
        } catch (Exception e) {
            discovery = null;
            call.reject("Couldn't search the network: " + e.getMessage());
        }
    }

    /** Android resolves one service at a time, so they're queued. */
    @SuppressWarnings("deprecation")
    private void resolveNext() {
        NsdServiceInfo next;
        synchronized (toResolve) {
            if (resolving || toResolve.isEmpty()) return;
            resolving = true;
            next = toResolve.poll();
        }
        try {
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo info, int err) {
                    synchronized (toResolve) { resolving = false; }
                    resolveNext();
                }
                @Override public void onServiceResolved(NsdServiceInfo info) {
                    if (info.getHost() != null) {
                        JSObject ev = new JSObject();
                        ev.put("id", info.getServiceName());
                        ev.put("name", info.getServiceName());
                        ev.put("host", info.getHost().getHostAddress());
                        ev.put("port", info.getPort());
                        notifyListeners("found", ev);
                    }
                    synchronized (toResolve) { resolving = false; }
                    resolveNext();
                }
            });
        } catch (Exception e) {
            synchronized (toResolve) { resolving = false; }
        }
    }

    @PluginMethod
    public void stopDiscover(PluginCall call) {
        stopDiscovery();
        call.resolve();
    }

    private void stopDiscovery() {
        if (discovery != null) {
            try { nsd.stopServiceDiscovery(discovery); } catch (Exception ignored) { }
            discovery = null;
        }
        synchronized (toResolve) { toResolve.clear(); resolving = false; }
        if (server == null) unlockMulticast();
    }

    /** Connect to a game found by discover(). */
    @PluginMethod
    public void join(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 0);
        leaveGame();
        io.execute(() -> {
            try {
                Socket socket = new Socket();
                socket.connect(new InetSocketAddress(host, port), 5000);
                socket.setTcpNoDelay(true);
                client = new Peer("host", socket);
                io.execute(() -> readLoop(client, false));
                call.resolve();
            } catch (Exception e) {
                call.reject("Couldn't connect: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        if (client != null) client.send(call.getString("data", ""));
        call.resolve();
    }

    @PluginMethod
    public void leave(PluginCall call) {
        leaveGame();
        call.resolve();
    }

    private void leaveGame() {
        if (client != null) { client.close(); client = null; }
    }

    // ---------------- Browsers on the same Wi-Fi (iPhones) ----------------

    private static final int WEB_PORT = 8790;
    private static final String SPRITES_URL = "https://raw.githubusercontent.com/robfulcher321-cloud/extra-sprites-for-aoe2-companion/main/";
    private ServerSocket web;
    private int gamePort;
    private String gameName = "Wonder Wars game";
    private final Map<String, Object> spriteLocks = new ConcurrentHashMap<>();

    private void startWeb() {
        if (web != null && !web.isClosed()) return;
        try {
            ServerSocket s = new ServerSocket();
            s.setReuseAddress(true);
            try { s.bind(new InetSocketAddress(WEB_PORT)); } catch (IOException busy) { s.bind(new InetSocketAddress(0)); }
            web = s;
            io.execute(() -> {
                while (!s.isClosed()) {
                    try {
                        Socket c = s.accept();
                        io.execute(() -> handleHttp(c));
                    } catch (Exception e) {
                        if (s.isClosed()) return;
                    }
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "web server: " + e);
            web = null;
        }
    }

    private void stopWeb() {
        if (web != null) {
            try { web.close(); } catch (Exception ignored) { }
            web = null;
        }
    }

    /** This phone's address on the Wi-Fi (an IPv4 address on the local network). */
    private String wifiAddress() {
        try {
            String fallback = null;
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress a : Collections.list(nif.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    String name = nif.getName().toLowerCase(Locale.ROOT);
                    if (name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("swlan")) return a.getHostAddress();
                    if (fallback == null) fallback = a.getHostAddress();
                }
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("header too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    private void handleHttp(Socket c) {
        try {
            c.setTcpNoDelay(true);
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();
            String request = readLine(in);
            if (request == null) { c.close(); return; }
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i > 0) headers.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
            }
            String[] parts = request.split(" ");
            String target = parts.length > 1 ? parts[1] : "/";
            String path = target.split("\\?")[0];
            String query = target.contains("?") ? target.substring(target.indexOf('?') + 1) : "";
            if ("websocket".equalsIgnoreCase(headers.get("upgrade")) && path.equals("/ws")) {
                webSocket(c, in, out, headers.get("sec-websocket-key"));
                return;
            }
            if (path.startsWith("/sprites/")) serveSprite(out, path.substring("/sprites/".length()), query);
            else serveAsset(out, path);
            out.flush();
        } catch (Exception e) {
            Log.i(TAG, "http: " + e);
        }
        try { c.close(); } catch (Exception ignored) { }
    }

    private static String typeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private static void head(OutputStream out, int code, String status, String type, long length) throws IOException {
        String h = "HTTP/1.1 " + code + " " + status + "\r\n"
            + (type != null ? "Content-Type: " + type + "\r\n" : "")
            + (length >= 0 ? "Content-Length: " + length + "\r\n" : "")
            + "Cache-Control: no-cache\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
    }

    private static void notFound(OutputStream out) throws IOException {
        byte[] b = "Not found".getBytes(StandardCharsets.UTF_8);
        head(out, 404, "Not Found", "text/plain", b.length);
        out.write(b);
    }

    /** The app's own files (the same web app the APK runs), from its assets. */
    private void serveAsset(OutputStream out, String path) throws IOException {
        String p = URLDecoder.decode(path, "UTF-8");
        if (p.equals("/") || p.isEmpty()) p = "/index.html";
        if (p.contains("..")) { notFound(out); return; }
        byte[] body;
        try (InputStream a = getContext().getAssets().open("public" + p)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = a.read(buf)) > 0) b.write(buf, 0, n);
            body = b.toByteArray();
        } catch (IOException missing) {
            notFound(out);
            return;
        }
        head(out, 200, "OK", typeOf(p), body.length);
        out.write(body);
    }

    /**
     * Game graphics for browsers, through this phone: the manifest fresh from GitHub when it can
     * be had, and each pack downloaded once and kept (by its hash), so phones joining over Wi-Fi
     * get them at Wi-Fi speed.
     */
    private void serveSprite(OutputStream out, String name, String query) throws IOException {
        if (name.contains("..") || name.isEmpty()) { notFound(out); return; }
        File dir = new File(getContext().getFilesDir(), "sprites");
        if (!dir.exists() && !dir.mkdirs()) { notFound(out); return; }
        File file;
        if (name.equals("manifest.json")) {
            file = new File(dir, "manifest.json");
            try { download(SPRITES_URL + "manifest.json", file); } catch (Exception offline) { Log.i(TAG, "manifest: using the kept copy"); }
        } else {
            String sha = "";
            for (String kv : query.split("&")) if (kv.startsWith("sha=")) sha = kv.substring(4).replaceAll("[^0-9a-fA-F]", "");
            String base = name.replace('/', '_');
            file = new File(dir, base + (sha.isEmpty() ? "" : "." + sha));
            Object lock = spriteLocks.computeIfAbsent(base, (k) -> new Object());
            synchronized (lock) {
                if (!file.exists()) {
                    try {
                        download(SPRITES_URL + name, file);
                        // drop older copies of this pack
                        File[] old = dir.listFiles((d, n) -> n.startsWith(base + ".") && !n.equals(file.getName()));
                        if (old != null) for (File f : old) f.delete();
                    } catch (Exception e) {
                        Log.w(TAG, "pack " + name + ": " + e);
                    }
                }
            }
        }
        if (!file.exists()) { notFound(out); return; }
        head(out, 200, "OK", name.endsWith(".json") ? "application/json" : "application/octet-stream", file.length());
        try (InputStream f = new FileInputStream(file)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = f.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static void download(String url, File to) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(8000);
        h.setReadTimeout(30000);
        try {
            if (h.getResponseCode() != 200) throw new IOException("HTTP " + h.getResponseCode());
            File tmp = new File(to.getPath() + ".part");
            try (InputStream in = h.getInputStream(); OutputStream o = new FileOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            }
            if (!tmp.renameTo(to)) { to.delete(); if (!tmp.renameTo(to)) throw new IOException("couldn't keep " + to.getName()); }
        } finally {
            h.disconnect();
        }
    }

    /** A browser player: messages to it go out as WebSocket text frames, wrapped like the relay's. */
    private static class WsPeer extends Conn {
        final OutputStream out;

        WsPeer(String id, Socket socket, OutputStream out) { super(id, socket); this.out = out; }

        @Override
        void send(String line) {
            try {
                JSONObject m = new JSONObject();
                m.put("op", "message");
                m.put("data", line);
                frame(m.toString());
            } catch (Exception ignored) { }
        }

        void frame(String text) {
            byte[] p = text.getBytes(StandardCharsets.UTF_8);
            writer.execute(() -> {
                try {
                    writeFrame(out, 0x1, p);
                } catch (Exception e) {
                    Log.w(TAG, "ws send: " + e);
                }
            });
        }
    }

    private static synchronized void writeFrame(OutputStream out, int opcode, byte[] p) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(p.length + 10);
        b.write(0x80 | opcode);
        if (p.length < 126) b.write(p.length);
        else if (p.length < 65536) { b.write(126); b.write(p.length >> 8); b.write(p.length & 0xff); }
        else { b.write(127); for (int i = 7; i >= 0; i--) b.write((int) (((long) p.length >> (8 * i)) & 0xff)); }
        b.write(p);
        out.write(b.toByteArray());
        out.flush();
    }

    private static void readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = in.read(b, off, b.length - off);
            if (n < 0) throw new IOException("closed");
            off += n;
        }
    }

    private void webSocket(Socket c, InputStream in, OutputStream out, String key) throws Exception {
        if (key == null) { c.close(); return; }
        String accept = android.util.Base64.encodeToString(
            MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.UTF_8)),
            android.util.Base64.NO_WRAP);
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
        c.setTcpNoDelay(true);
        WsPeer me = new WsPeer("w" + nextPeer.getAndIncrement(), c, out);
        boolean joined = false;
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        try {
            while (true) {
                int b0 = in.read();
                if (b0 < 0) break;
                int b1 = in.read();
                if (b1 < 0) break;
                long len = b1 & 0x7f;
                if (len == 126) { len = ((in.read() & 0xff) << 8) | (in.read() & 0xff); }
                else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | (in.read() & 0xff); }
                if (len > (1 << 20)) break;   // nothing the game sends is anywhere near this
                byte[] mask = new byte[4];
                if ((b1 & 0x80) != 0) readFully(in, mask);
                byte[] p = new byte[(int) len];
                readFully(in, p);
                if ((b1 & 0x80) != 0) for (int i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
                int op = b0 & 0x0f;
                if (op == 0x8) break;
                if (op == 0x9) { writeFrame(out, 0xA, p); continue; }
                if (op != 0x1 && op != 0x0) continue;
                message.write(p);
                if ((b0 & 0x80) == 0) continue;   // more of this message to come
                JSONObject m = new JSONObject(message.toString("UTF-8"));
                message.reset();
                String what = m.optString("op");
                if (what.equals("discover")) {
                    if (server != null && registration != null) {
                        JSONObject f = new JSONObject();
                        f.put("op", "found"); f.put("id", "g" + gamePort); f.put("name", gameName); f.put("host", "relay"); f.put("port", gamePort);
                        me.frame(f.toString());
                    }
                } else if (what.equals("join")) {
                    JSONObject r = new JSONObject();
                    r.put("op", "reply");
                    if (server == null) r.put("error", "Couldn't connect: game gone");
                    else if (!joined) {
                        joined = true;
                        peers.put(me.id, me);
                        JSObject ev = new JSObject();
                        ev.put("peer", me.id);
                        ev.put("state", "join");
                        notifyListeners("peer", ev);
                    }
                    me.frame(r.toString());
                } else if (what.equals("send") && joined) {
                    JSObject ev = new JSObject();
                    ev.put("peer", me.id);
                    ev.put("data", m.optString("data"));
                    notifyListeners("message", ev);
                } else if (what.equals("leave") && joined) {
                    joined = false;
                    if (peers.remove(me.id) != null) {
                        JSObject ev = new JSObject();
                        ev.put("peer", me.id);
                        ev.put("state", "leave");
                        notifyListeners("peer", ev);
                    }
                }
            }
        } catch (Exception e) {
            Log.i(TAG, "ws ended: " + e);
        }
        me.close();
        if (joined && peers.remove(me.id) != null) {
            JSObject ev = new JSObject();
            ev.put("peer", me.id);
            ev.put("state", "leave");
            notifyListeners("peer", ev);
        }
    }

    // ---------------- Shared ----------------

    private void readLoop(Peer peer, boolean hosting) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(peer.socket.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                JSObject ev = new JSObject();
                if (hosting) ev.put("peer", peer.id);
                ev.put("data", line);
                notifyListeners("message", ev);
            }
        } catch (Exception e) {
            Log.i(TAG, "connection ended: " + e);
        }
        peer.close();
        if (hosting) {
            if (peers.remove(peer.id) != null) {
                JSObject ev = new JSObject();
                ev.put("peer", peer.id);
                ev.put("state", "leave");
                notifyListeners("peer", ev);
            }
        } else if (client == peer) {
            client = null;
            notifyListeners("closed", new JSObject());
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopHosting();
        stopDiscovery();
        leaveGame();
        io.shutdownNow();
    }
}
