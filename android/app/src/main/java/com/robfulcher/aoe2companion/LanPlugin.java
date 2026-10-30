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

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
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
    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private final AtomicInteger nextPeer = new AtomicInteger(1);

    // Joining
    private Peer client;

    // Discovery
    private NsdManager.DiscoveryListener discovery;
    private final ArrayDeque<NsdServiceInfo> toResolve = new ArrayDeque<>();
    private boolean resolving = false;

    private final ExecutorService io = Executors.newCachedThreadPool();

    /** One connection: its socket, a writer used from one thread at a time, and its id. */
    private static class Peer {
        final String id;
        final Socket socket;
        final BufferedWriter out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();

        Peer(String id, Socket socket) throws Exception {
            this.id = id;
            this.socket = socket;
            this.out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        }

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

        void close() {
            try { socket.close(); } catch (Exception ignored) { }
            writer.shutdownNow();
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
        JSObject ret = new JSObject();
        ret.put("port", port);
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
        for (Peer p : peers.values()) p.close();
        peers.clear();
        if (discovery == null) unlockMulticast();
    }

    @PluginMethod
    public void sendTo(PluginCall call) {
        Peer p = peers.get(call.getString("peer", ""));
        if (p != null) p.send(call.getString("data", ""));
        call.resolve();
    }

    @PluginMethod
    public void broadcast(PluginCall call) {
        String data = call.getString("data", "");
        for (Peer p : peers.values()) p.send(data);
        call.resolve();
    }

    @PluginMethod
    public void kick(PluginCall call) {
        Peer p = peers.remove(call.getString("peer", ""));
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
