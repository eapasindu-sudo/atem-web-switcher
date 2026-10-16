// sony-bridge: connects to Sony cameras with the Sony Camera Remote SDK and
// talks to the ATEM Switcher server over stdin/stdout, one JSON object per line.
//
// Commands (stdin):
//   {"cmd":"scan"}
//   {"cmd":"connect","id":"cam1","ip":"192.168.1.20","model":"ILME-FX3","user":"admin","pass":"xxxx"}
//   {"cmd":"disconnect","id":"cam1"}
//   {"cmd":"set","id":"cam1","prop":"iso","value":800}
//   {"cmd":"rec","id":"cam1","on":1}
//   {"cmd":"focus","id":"cam1","speed":-3}      (-7..7, 0 stops)
//   {"cmd":"quit"}
// Events (stdout):
//   {"ev":"ready"}
//   {"ev":"scan","cams":[{"model":"ILME-FX3","name":"...","ip":"...","mac":"...","ssh":1}]}
//   {"ev":"status","id":"cam1","state":"connecting|connected|reconnecting|disconnected|error","error":"0x8208"}
//   {"ev":"props","id":"cam1","props":{"iso":{"v":800,"w":1,"c":[...]},"kelvin":{"v":5600,"w":1,"min":..,"max":..,"step":..}}}
//   {"ev":"log","msg":"..."}
// Values are the raw SDK numbers; the web page turns them into text (F2.8, 1/50, ISO 800).

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#endif

#include "CameraRemote_SDK.h"
#include "CrDeviceProperty.h"
#include "IDeviceCallback.h"
#include "crprop.h"

namespace SDK = SCRSDK;

// ---------- output ----------

static std::mutex g_outMx;
static void emit(const std::string& line)
{
    std::lock_guard<std::mutex> lock(g_outMx);
    fwrite(line.data(), 1, line.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static std::string jstr(const std::string& s)
{
    std::string o = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
        else if (c == '\n') o += "\\n";
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o + "\"";
}

static std::string hex(uint32_t v)
{
    char b[16];
    snprintf(b, sizeof b, "0x%x", v);
    return b;
}

static void logmsg(const std::string& m) { emit("{\"ev\":\"log\",\"msg\":" + jstr(m) + "}"); }

static std::string narrow(const CrChar* s)
{
    if (!s) return "";
#if defined(_WIN32)
    int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return "";
    std::string o(n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s, -1, &o[0], n, nullptr, nullptr);
    return o;
#else
    return std::string(s);
#endif
}

// ---------- tiny JSON reader (flat objects with string/number values) ----------

using Obj = std::map<std::string, std::string>;

static bool parseFlat(const std::string& s, Obj& out)
{
    size_t i = 0, n = s.size();
    auto ws = [&] { while (i < n && isspace((unsigned char)s[i])) i++; };
    auto str = [&](std::string& v) -> bool {
        if (i >= n || s[i] != '"') return false;
        i++;
        while (i < n && s[i] != '"') {
            if (s[i] == '\\' && i + 1 < n) {
                i++;
                char c = s[i];
                v += c == 'n' ? '\n' : c == 't' ? '\t' : c;
            } else v += s[i];
            i++;
        }
        if (i >= n) return false;
        i++;
        return true;
    };
    ws();
    if (i >= n || s[i] != '{') return false;
    i++;
    for (;;) {
        ws();
        if (i < n && s[i] == '}') return true;
        std::string k, v;
        if (!str(k)) return false;
        ws();
        if (i >= n || s[i] != ':') return false;
        i++;
        ws();
        if (i < n && s[i] == '"') { if (!str(v)) return false; }
        else { while (i < n && s[i] != ',' && s[i] != '}') v += s[i++]; while (!v.empty() && isspace((unsigned char)v.back())) v.pop_back(); }
        if (v == "true") v = "1";
        if (v == "false" || v == "null") v = "0";
        out[k] = v;
        ws();
        if (i < n && s[i] == ',') { i++; continue; }
        if (i < n && s[i] == '}') return true;
        return false;
    }
}

static long long num(const Obj& o, const char* k, long long def = 0)
{
    auto it = o.find(k);
    if (it == o.end() || it->second.empty()) return def;
    try { return std::stoll(it->second, nullptr, 0); } catch (...) { return def; }
}

static std::string get(const Obj& o, const char* k)
{
    auto it = o.find(k);
    return it == o.end() ? "" : it->second;
}

// ---------- properties we show on the CCU screen ----------

struct PropDef { const char* name; CrInt32u code; };
static const PropDef PROPS[] = {
    { "exposure",   SDK::CrDeviceProperty_ExposureProgramMode },
    { "iris",       SDK::CrDeviceProperty_FNumber },
    { "irisMode",   SDK::CrDeviceProperty_IrisModeSetting },
    { "shutter",    SDK::CrDeviceProperty_ShutterSpeed },
    { "angle",      SDK::CrDeviceProperty_ShutterAngle },
    { "shutterMode",SDK::CrDeviceProperty_ShutterModeSetting },
    { "shutterOn",  SDK::CrDeviceProperty_ShutterSetting },
    { "iso",        SDK::CrDeviceProperty_IsoSensitivity },
    { "ei",         SDK::CrDeviceProperty_ExposureIndex },
    { "baseIso",    SDK::CrDeviceProperty_BaseISOSwitchEI },
    { "gainMode",   SDK::CrDeviceProperty_GainControlSetting },
    { "wb",         SDK::CrDeviceProperty_WhiteBalance },
    { "kelvin",     SDK::CrDeviceProperty_Colortemp },
    { "nd",         SDK::CrDeviceProperty_NDFilterValue },
    { "ndMode",     SDK::CrDeviceProperty_NDFilterMode },
    { "ndOn",       SDK::CrDeviceProperty_NDFilter },
    { "focusMode",  SDK::CrDeviceProperty_FocusMode },
    { "focusSpeed", SDK::CrDeviceProperty_Focus_Speed_Range },
    { "rec",        SDK::CrDeviceProperty_RecordingState },
    { "battery",    SDK::CrDeviceProperty_BatteryRemain },
    { "priority",   SDK::CrDeviceProperty_PriorityKeySettings },
};
static const size_t NPROPS = sizeof(PROPS) / sizeof(PROPS[0]);

static const PropDef* propByName(const std::string& n)
{
    for (auto& p : PROPS) if (n == p.name) return &p;
    return nullptr;
}
static const char* propName(CrInt32u code)
{
    for (auto& p : PROPS) if (p.code == code) return p.name;
    return nullptr;
}

static std::vector<long long> decodeValues(CrInt32u type, const CrInt8u* buf, CrInt32u size)
{
    std::vector<long long> out;
    if (!buf || !size) return out;
    int len;
    switch (type & 0x000F) {
    case SDK::CrDataType_UInt8: len = 1; break;
    case SDK::CrDataType_UInt16: len = 2; break;
    case SDK::CrDataType_UInt32: len = 4; break;
    case SDK::CrDataType_UInt64: len = 8; break;
    default: return out;
    }
    bool sign = (type & SDK::CrDataType_SignBit) != 0;
    for (CrInt32u off = 0; off + len <= size; off += len) {
        long long v = 0;
        switch (len) {
        case 1: { uint8_t x; memcpy(&x, buf + off, 1); v = sign ? (long long)(int8_t)x : x; break; }
        case 2: { uint16_t x; memcpy(&x, buf + off, 2); v = sign ? (long long)(int16_t)x : x; break; }
        case 4: { uint32_t x; memcpy(&x, buf + off, 4); v = sign ? (long long)(int32_t)x : x; break; }
        case 8: { uint64_t x; memcpy(&x, buf + off, 8); v = (long long)x; break; }
        }
        out.push_back(v);
    }
    return out;
}

static long long signedCurrent(CrInt32u type, CrInt64u cur)
{
    if (!(type & SDK::CrDataType_SignBit)) return (long long)cur;
    switch (type & 0x000F) {
    case SDK::CrDataType_UInt8: return (int8_t)cur;
    case SDK::CrDataType_UInt16: return (int16_t)cur;
    case SDK::CrDataType_UInt32: return (int32_t)cur;
    default: return (long long)cur;
    }
}

// ---------- cameras ----------

struct Camera;
static std::mutex g_camMx;
static std::map<std::string, std::shared_ptr<Camera>> g_cams;

struct Camera : public SDK::IDeviceCallback
{
    std::string id, ip, model;
    SDK::CrDeviceHandle handle = 0;
    std::atomic<bool> connected{ false };
    std::atomic<bool> dirty{ false };
    std::atomic<bool> released{ false };

    void status(const char* state, CrInt32u err = 0)
    {
        std::string s = "{\"ev\":\"status\",\"id\":" + jstr(id) + ",\"state\":\"" + state + "\"";
        if (err) s += ",\"error\":\"" + hex(err) + "\"";
        emit(s + "}");
    }

    void OnConnected(SDK::DeviceConnectionVersioin) override
    {
        connected = true;
        dirty = true;
        status("connected");
    }
    void OnDisconnected(CrInt32u error) override
    {
        connected = false;
        if (!released) status("disconnected", error);
    }
    void OnPropertyChanged() override { dirty = true; }
    void OnPropertyChangedCodes(CrInt32u, CrInt32u*) override { dirty = true; }
    void OnError(CrInt32u error) override
    {
        connected = false;
        status("error", error);
    }
    void OnWarning(CrInt32u warning) override
    {
        if (warning == SDK::CrWarning_Connect_Reconnecting) status("reconnecting");
        else if (warning == SDK::CrWarning_Connect_Reconnected) { connected = true; dirty = true; status("connected"); }
    }

    // reads one property; values/strings are not kept (they belong to the SDK's list)
    bool getProp(CrInt32u code, CrProp& out)
    {
        CrInt32 n = 0;
        SDK::CrDeviceProperty* list = nullptr;
        CrInt32u c = code;
        auto err = SDK::GetSelectDeviceProperties(handle, 1, &c, &list, &n);
        bool ok = !err && list && n > 0;
        if (ok) {
            out = asProps(list)[0];
            out.currentStr = nullptr;
            out.values = out.getSetValues = nullptr;
            out.valuesSize = out.getSetValuesSize = 0;
        }
        if (list) SDK::ReleaseDeviceProperties(handle, list);
        return ok;
    }

    bool writeProp(CrInt32u code, SDK::CrDataType type, CrInt64u value)
    {
        CrProp p{};
        p.code = code;
        p.valueType = type;
        p.currentValue = value;
        auto err = SDK::SetDeviceProperty(handle, asSdk(&p));
        if (err) logmsg(id + ": set failed " + hex(err));
        return !err;
    }

    bool setProp(CrInt32u code, long long value)
    {
        CrProp p;
        if (!getProp(code, p)) return false;
        if (!propWritable(p)) { logmsg(id + ": " + (propName(code) ? propName(code) : "property") + " cannot be changed now"); return false; }
        return writeProp(code, p.valueType, (CrInt64u)value);
    }

    void sendProps()
    {
        std::vector<CrInt32u> codes;
        for (auto& p : PROPS) codes.push_back(p.code);
        CrInt32 n = 0;
        SDK::CrDeviceProperty* list = nullptr;
        auto err = SDK::GetSelectDeviceProperties(handle, (CrInt32u)codes.size(), codes.data(), &list, &n);
        if (err || !list) { if (list) SDK::ReleaseDeviceProperties(handle, list); return; }
        std::ostringstream o;
        o << "{\"ev\":\"props\",\"id\":" << jstr(id) << ",\"props\":{";
        bool first = true;
        const CrProp* props = asProps(list);
        for (CrInt32 i = 0; i < n; i++) {
            const CrProp& p = props[i];
            const char* name = propName(p.code);
            if (!name) continue;
            if (p.enableFlag == SDK::CrEnableValue_NotSupported) continue;
            CrInt32u type = p.valueType;
            if (type == SDK::CrDataType_STR) continue;
            if (!first) o << ',';
            first = false;
            // 64-bit values (ND) go out as strings, JavaScript numbers can't hold them exactly
            bool big = (type & 0x000F) == SDK::CrDataType_UInt64;
            auto fmt = [big](long long v) { return big ? "\"" + std::to_string((unsigned long long)v) + "\"" : std::to_string(v); };
            o << jstr(name) << ":{\"v\":" << fmt(signedCurrent(type, p.currentValue))
              << ",\"w\":" << (propWritable(p) ? 1 : 0);
            auto vals = decodeValues(type, p.values, p.valuesSize);
            if ((type & SDK::CrDataType_RangeBit) && vals.size() >= 3) {
                o << ",\"min\":" << fmt(vals[0]) << ",\"max\":" << fmt(vals[1]) << ",\"step\":" << fmt(vals[2]);
            } else if (!vals.empty()) {
                o << ",\"c\":[";
                for (size_t k = 0; k < vals.size(); k++) o << (k ? "," : "") << fmt(vals[k]);
                o << ']';
            }
            o << '}';
        }
        o << "}}";
        SDK::ReleaseDeviceProperties(handle, list);
        emit(o.str());
    }
};

static bool parseIp(const std::string& s, CrInt32u& out)
{
    unsigned a, b, c, d;
    char extra;
    if (sscanf(s.c_str(), "%u.%u.%u.%u%c", &a, &b, &c, &d, &extra) != 4) return false;
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    out = a | (b << 8) | (c << 16) | (d << 24); // first octet in the low byte, like the SDK sample
    return true;
}

struct ModelName { const char* name; SDK::CrCameraDeviceModelList model; };
static const ModelName MODELS[] = {
    { "ILME-FX3", SDK::CrCameraDeviceModel_ILME_FX3 },
    { "ILME-FX3A", SDK::CrCameraDeviceModel_ILME_FX3A },
    { "ILME-FX30", SDK::CrCameraDeviceModel_ILME_FX30 },
    { "ILME-FX6", SDK::CrCameraDeviceModel_ILME_FX6 },
    { "ILME-FX2", SDK::CrCameraDeviceModel_ILME_FX2 },
    { "ILCE-7M4", SDK::CrCameraDeviceModel_ILCE_7M4 },
    { "ILCE-7M5", SDK::CrCameraDeviceModel_ILCE_7M5 },
    { "ILCE-7SM3", SDK::CrCameraDeviceModel_ILCE_7SM3 },
    { "ILCE-7CM2", SDK::CrCameraDeviceModel_ILCE_7CM2 },
    { "ILCE-7CR", SDK::CrCameraDeviceModel_ILCE_7CR },
    { "ILCE-7RM5", SDK::CrCameraDeviceModel_ILCE_7RM5 },
    { "ILCE-7RM4A", SDK::CrCameraDeviceModel_ILCE_7RM4A },
    { "ILCE-7RM4", SDK::CrCameraDeviceModel_ILCE_7RM4 },
    { "ILCE-7C", SDK::CrCameraDeviceModel_ILCE_7C },
    { "ILCE-1", SDK::CrCameraDeviceModel_ILCE_1 },
    { "ILCE-1M2", SDK::CrCameraDeviceModel_ILCE_1M2 },
    { "ILCE-9M3", SDK::CrCameraDeviceModel_ILCE_9M3 },
    { "ILCE-6700", SDK::CrCameraDeviceModel_ILCE_6700 },
    { "ZV-E1", SDK::CrCameraDeviceModel_ZV_E1 },
};

static void cmdScan()
{
    SDK::ICrEnumCameraObjectInfo* en = nullptr;
    auto err = SDK::EnumCameraObjects(&en, 3);
    std::ostringstream o;
    o << "{\"ev\":\"scan\",\"cams\":[";
    if (!err && en) {
        bool first = true;
        for (CrInt32u i = 0; i < en->GetCount(); i++) {
            auto* info = en->GetCameraObjectInfo(i);
            if (!info) continue;
            std::string type = narrow(info->GetConnectionTypeName());
            if (type != "IP") continue; // Wi-Fi / LAN only, USB is not used here
            if (!first) o << ',';
            first = false;
            o << "{\"model\":" << jstr(narrow(info->GetModel()))
              << ",\"name\":" << jstr(narrow(info->GetName()))
              << ",\"ip\":" << jstr(narrow(info->GetIPAddressChar()))
              << ",\"mac\":" << jstr(narrow(info->GetMACAddressChar()))
              << ",\"ssh\":" << (info->GetSSHsupport() == SDK::CrSSHsupport_ON ? 1 : 0) << '}';
        }
    }
    o << "]}";
    if (en) en->Release();
    emit(o.str());
}

// returns true when a camera session was closed
static bool cmdDisconnect(const std::string& id)
{
    std::shared_ptr<Camera> cam;
    {
        std::lock_guard<std::mutex> lock(g_camMx);
        auto it = g_cams.find(id);
        if (it == g_cams.end()) return false;
        cam = it->second;
        g_cams.erase(it);
    }
    cam->released = true;
    if (cam->handle) {
        SDK::Disconnect(cam->handle);
        SDK::ReleaseDevice(cam->handle);
    }
    cam->status("disconnected");
    // keep the callback object alive a little in case the SDK still calls it
    std::thread([cam] { std::this_thread::sleep_for(std::chrono::seconds(5)); }).detach();
    return cam->handle != 0;
}

static void cmdConnect(const Obj& o)
{
    std::string id = get(o, "id"), ipText = get(o, "ip"), modelText = get(o, "model");
    std::string user = get(o, "user"), pass = get(o, "pass");
    if (user.empty()) user = "admin";
    // give the camera a moment to drop the old session, or it answers "already connected"
    if (cmdDisconnect(id)) std::this_thread::sleep_for(std::chrono::seconds(2));

    auto cam = std::make_shared<Camera>();
    cam->id = id;
    cam->ip = ipText;
    cam->model = modelText;

    CrInt32u ip;
    if (!parseIp(ipText, ip)) { cam->status("error", SDK::CrError_Generic_InvalidParameter); return; }
    const ModelName* m = nullptr;
    for (auto& x : MODELS) if (modelText == x.name) m = &x;
    if (!m) { logmsg("Unknown camera model " + modelText); cam->status("error", SDK::CrError_Generic_InvalidParameter); return; }

    CrInt8u mac[6] = { 0, 0, 0, 0, 0, 0 };
    std::string macText = get(o, "mac");
    if (!macText.empty()) {
        unsigned b[6];
        if (sscanf(macText.c_str(), "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) == 6)
            for (int k = 0; k < 6; k++) mac[k] = (CrInt8u)b[k];
    }
    CrInt32u ssh = pass.empty() ? SDK::CrSSHsupport_OFF : SDK::CrSSHsupport_ON;

    cam->status("connecting");
    SDK::ICrCameraObjectInfo* info = nullptr;
    auto err = SDK::CreateCameraObjectInfoEthernetConnection(&info, m->model, ip, mac, ssh);
    if (err || !info) { cam->status("error", err); return; }

    std::string fp;
    if (ssh == SDK::CrSSHsupport_ON) {
        char fpBuf[256] = { 0 };
        CrInt32u fpLen = 0;
        err = SDK::GetFingerprint(info, fpBuf, &fpLen);
        if (err) { info->Release(); cam->status("error", err); return; }
        fp.assign(fpBuf, fpLen);
    }

    {
        std::lock_guard<std::mutex> lock(g_camMx);
        g_cams[id] = cam;
    }
    err = SDK::Connect(info, cam.get(), &cam->handle, SDK::CrSdkControlMode_Remote, SDK::CrReconnecting_ON,
                       ssh ? user.c_str() : nullptr, ssh ? pass.c_str() : nullptr,
                       ssh ? fp.c_str() : nullptr, (CrInt32u)fp.size());
    info->Release();
    if (err) {
        std::lock_guard<std::mutex> lock(g_camMx);
        g_cams.erase(id);
        cam->status("error", err);
    }
}

static std::shared_ptr<Camera> findCam(const std::string& id)
{
    std::lock_guard<std::mutex> lock(g_camMx);
    auto it = g_cams.find(id);
    if (it == g_cams.end() || !it->second->connected) return nullptr;
    return it->second;
}

static void onConnectedSetup(Camera& cam)
{
    // Let the PC change settings even when the camera's own dials are set otherwise.
    CrProp p;
    if (cam.getProp(SDK::CrDeviceProperty_PriorityKeySettings, p) && propWritable(p) &&
        p.currentValue != SDK::CrPriorityKey_PCRemote)
        cam.writeProp(p.code, p.valueType, SDK::CrPriorityKey_PCRemote);
}

static void cmdRec(Camera& cam, bool on)
{
    // MovieRecord: Down starts, Up stops. Some bodies toggle on Down, so always follow Down with Up when starting.
    if (on) {
        SDK::SendCommand(cam.handle, SDK::CrCommandId_MovieRecord, SDK::CrCommandParam_Down);
        std::this_thread::sleep_for(std::chrono::milliseconds(60));
        SDK::SendCommand(cam.handle, SDK::CrCommandId_MovieRecord, SDK::CrCommandParam_Up);
    } else {
        CrProp p;
        bool recording = cam.getProp(SDK::CrDeviceProperty_RecordingState, p) &&
                         p.currentValue == SDK::CrMovie_Recording_State_Recording;
        if (!recording) return;
        SDK::SendCommand(cam.handle, SDK::CrCommandId_MovieRecord, SDK::CrCommandParam_Down);
        std::this_thread::sleep_for(std::chrono::milliseconds(60));
        SDK::SendCommand(cam.handle, SDK::CrCommandId_MovieRecord, SDK::CrCommandParam_Up);
    }
    cam.dirty = true;
}

// ---------- main loop ----------

static std::mutex g_inMx;
static std::condition_variable g_inCv;
static std::deque<std::string> g_inbox;
static std::atomic<bool> g_quit{ false };

int main()
{
#if defined(_WIN32)
    _setmode(_fileno(stdout), _O_BINARY);
    // the SDK finds CrAdapter\ next to the exe; make that the working folder
    wchar_t path[MAX_PATH];
    DWORD len = GetModuleFileNameW(nullptr, path, MAX_PATH);
    if (len && len < MAX_PATH) {
        for (DWORD i = len; i > 0; i--) if (path[i - 1] == L'\\') { path[i - 1] = 0; break; }
        SetCurrentDirectoryW(path);
    }
#endif
    if (!SDK::Init()) {
        emit("{\"ev\":\"fatal\",\"msg\":\"Sony SDK did not start\"}");
        return 1;
    }
    emit("{\"ev\":\"ready\"}");

    std::thread reader([] {
        std::string line;
        while (std::getline(std::cin, line)) {
            std::lock_guard<std::mutex> lock(g_inMx);
            g_inbox.push_back(line);
            g_inCv.notify_one();
        }
        std::lock_guard<std::mutex> lock(g_inMx);
        g_inbox.push_back("{\"cmd\":\"quit\"}"); // parent closed the pipe
        g_inCv.notify_one();
    });
    reader.detach();

    std::map<std::string, bool> setupDone;
    auto lastPoll = std::chrono::steady_clock::now();

    while (!g_quit) {
        std::string line;
        {
            std::unique_lock<std::mutex> lock(g_inMx);
            g_inCv.wait_for(lock, std::chrono::milliseconds(80), [] { return !g_inbox.empty(); });
            if (!g_inbox.empty()) { line = g_inbox.front(); g_inbox.pop_front(); }
        }

        if (!line.empty()) {
            Obj o;
            if (!parseFlat(line, o)) { logmsg("bad command: " + line); continue; }
            std::string cmd = get(o, "cmd"), id = get(o, "id");
            if (cmd == "quit") { g_quit = true; break; }
            else if (cmd == "scan") cmdScan();
            else if (cmd == "connect") { setupDone.erase(id); cmdConnect(o); }
            else if (cmd == "disconnect") cmdDisconnect(id);
            else if (auto cam = findCam(id)) {
                if (cmd == "set") {
                    const PropDef* p = propByName(get(o, "prop"));
                    if (p) {
                        std::string v = get(o, "value");
                        long long value = 0;
                        try { value = v.size() && v[0] == '-' ? std::stoll(v) : (long long)std::stoull(v); } catch (...) { continue; }
                        cam->setProp(p->code, value);
                        cam->dirty = true;
                    }
                } else if (cmd == "rec") cmdRec(*cam, num(o, "on") != 0);
                else if (cmd == "focus") {
                    cam->writeProp(SDK::CrDeviceProperty_Focus_Operation, SDK::CrDataType_Int8,
                                   (CrInt64u)(int64_t)(int8_t)num(o, "speed"));
                } else if (cmd == "refresh") cam->dirty = true;
            }
        }

        // push changed settings to the server; also refresh every 2 s as a safety net
        auto now = std::chrono::steady_clock::now();
        bool poll = now - lastPoll > std::chrono::seconds(2);
        if (poll) lastPoll = now;
        std::vector<std::shared_ptr<Camera>> cams;
        {
            std::lock_guard<std::mutex> lock(g_camMx);
            for (auto& kv : g_cams) cams.push_back(kv.second);
        }
        for (auto& cam : cams) {
            if (!cam->connected) continue;
            if (!setupDone[cam->id]) { setupDone[cam->id] = true; onConnectedSetup(*cam); }
            if (cam->dirty.exchange(false) || poll) cam->sendProps();
        }
    }

    std::vector<std::string> ids;
    {
        std::lock_guard<std::mutex> lock(g_camMx);
        for (auto& kv : g_cams) ids.push_back(kv.first);
    }
    for (auto& id : ids) cmdDisconnect(id);
    SDK::Release();
    return 0;
}
