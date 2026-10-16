// A pretend Sony SDK, so the bridge can be built and tested on Linux without a camera.
// It acts like one FX3 at any IP address. Build: build/sony-bridge/mock/build-mock.sh
#include <atomic>
#include <chrono>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "CameraRemote_SDK.h"
#include "CrDeviceProperty.h"
#include "IDeviceCallback.h"
#include "../crprop.h"

namespace SCRSDK {

// ---- properties: stored as CrProp (same layout as CrDeviceProperty) with owned value lists ----
struct Stored {
    CrProp p{};
    std::vector<CrInt8u> vals;
};
static CrProp* copyOut(const Stored& st)
{
    CrProp* p = new CrProp(st.p);
    p->valuesSize = (CrInt32u)st.vals.size();
    p->values = nullptr;
    if (!st.vals.empty()) { p->values = new CrInt8u[st.vals.size()]; memcpy(p->values, st.vals.data(), st.vals.size()); }
    return p;
}

// ---- camera info ----
struct MockInfo : ICrCameraObjectInfo {
    std::string ip = "192.168.1.50";
    void Release() override { delete this; }
    CrChar* GetName() const override { return (CrChar*)"FX3"; }
    CrInt32u GetNameSize() const override { return 3; }
    CrChar* GetModel() const override { return (CrChar*)"ILME-FX3"; }
    CrInt32u GetModelSize() const override { return 8; }
    CrInt16 GetUsbPid() const override { return 0; }
    CrInt8u* GetId() const override { return (CrInt8u*)"00:11:22:33:44:55"; }
    CrInt32u GetIdSize() const override { return 17; }
    CrInt32u GetIdType() const override { return 0; }
    CrInt32u GetConnectionStatus() const override { return 0; }
    CrChar* GetConnectionTypeName() const override { return (CrChar*)"IP"; }
    CrChar* GetAdaptorName() const override { return (CrChar*)"Cr_PTP_IP"; }
    CrChar* GetGuid() const override { return (CrChar*)""; }
    CrChar* GetPairingNecessity() const override { return (CrChar*)"OFF"; }
    CrInt16u GetAuthenticationState() const override { return 0; }
    CrInt32u GetSSHsupport() const override { return CrSSHsupport_ON; }
    CrInt32u GetIPAddress() const override { return 0x3201A8C0; }
    CrChar* GetIPAddressChar() const override { return (CrChar*)ip.c_str(); }
    CrInt32u GetIPAddressCharSize() const override { return (CrInt32u)ip.size(); }
    CrInt8u* GetMACAddress() const override { return nullptr; }
    CrInt32u GetMACAddressSize() const override { return 6; }
    CrChar* GetMACAddressChar() const override { return (CrChar*)"00:11:22:33:44:55"; }
    CrInt32u GetMACAddressCharSize() const override { return 17; }
};
struct MockEnum : ICrEnumCameraObjectInfo {
    MockInfo info;
    CrInt32u GetCount() const override { return 1; }
    const ICrCameraObjectInfo* GetCameraObjectInfo(CrInt32u) const override { return &info; }
    void Release() override { delete this; }
};

// ---- one pretend camera ----
static std::mutex mx;
static std::map<CrInt32u, Stored> store;
static IDeviceCallback* cb = nullptr;

template <typename T>
static void add(CrInt32u code, CrDataType type, CrInt64u cur, std::vector<T> vals, CrPropertyEnableFlag en = CrEnableValue_True)
{
    Stored st;
    st.p.code = code;
    st.p.valueType = type;
    st.p.currentValue = cur;
    st.p.enableFlag = en;
    st.vals.resize(vals.size() * sizeof(T));
    if (!vals.empty()) memcpy(st.vals.data(), vals.data(), st.vals.size());
    store[code] = st;
}

static void fill()
{
    store.clear();
    add<uint32_t>(CrDeviceProperty_ExposureProgramMode, CrDataType_UInt32Array, CrExposure_Movie_M, { CrExposure_Movie_P, CrExposure_Movie_A, CrExposure_Movie_S, CrExposure_Movie_M });
    add<uint16_t>(CrDeviceProperty_FNumber, CrDataType_UInt16Array, 280, { 140, 160, 180, 200, 220, 250, 280, 320, 350, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1100, 1300, 1400, 1600, 1800, 2000, 2200 });
    add<uint8_t>(CrDeviceProperty_IrisModeSetting, CrDataType_UInt8Array, CrIrisMode_Manual, { CrIrisMode_Automatic, CrIrisMode_Manual });
    std::vector<uint32_t> ss;
    for (uint32_t d : { 8000u, 6400u, 5000u, 4000u, 3200u, 2500u, 2000u, 1600u, 1250u, 1000u, 800u, 640u, 500u, 400u, 320u, 250u, 200u, 160u, 125u, 100u, 80u, 60u, 50u, 40u, 30u, 25u, 15u, 8u, 4u })
        ss.push_back((1u << 16) | d);
    ss.push_back((5u << 16) | 10u); // 0.5"
    ss.push_back((1u << 16) | 1u);  // 1"
    add<uint32_t>(CrDeviceProperty_ShutterSpeed, CrDataType_UInt32Array, (1u << 16) | 50u, ss);
    add<uint8_t>(CrDeviceProperty_ShutterModeSetting, CrDataType_UInt8Array, CrShutterMode_Manual, { CrShutterMode_Automatic, CrShutterMode_Manual });
    add<uint32_t>(CrDeviceProperty_IsoSensitivity, CrDataType_UInt32Array, 800, { 0xFFFFFF, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800 });
    add<uint16_t>(CrDeviceProperty_WhiteBalance, CrDataType_UInt16Array, CrWhiteBalance_ColorTemp, { CrWhiteBalance_AWB, CrWhiteBalance_Daylight, CrWhiteBalance_Shadow, CrWhiteBalance_Cloudy, CrWhiteBalance_Tungsten, CrWhiteBalance_Fluorescent_WarmWhite, CrWhiteBalance_ColorTemp, CrWhiteBalance_Custom_1 });
    add<uint16_t>(CrDeviceProperty_Colortemp, CrDataType_UInt16Range, 5600, { 2500, 9900, 100 });
    add<uint16_t>(CrDeviceProperty_FocusMode, CrDataType_UInt16Array, CrFocus_MF, { CrFocus_AF_C, CrFocus_MF, CrFocus_DMF });
    add<int8_t>(CrDeviceProperty_Focus_Speed_Range, CrDataType_Int8Range, 0, { 1, 7, 1 }, CrEnableValue_DisplayOnly);
    add<uint16_t>(CrDeviceProperty_RecordingState, CrDataType_UInt16Range, 0, {}, CrEnableValue_DisplayOnly);
    add<int16_t>(CrDeviceProperty_BatteryRemain, CrDataType_Int16Range, 78, { 0, 100, 1 }, CrEnableValue_DisplayOnly);
    add<uint16_t>(CrDeviceProperty_PriorityKeySettings, CrDataType_UInt16Array, CrPriorityKey_CameraPosition, { CrPriorityKey_CameraPosition, CrPriorityKey_PCRemote });
}

static void later(int ms, void (IDeviceCallback::*fn)())
{
    std::thread([ms, fn] {
        std::this_thread::sleep_for(std::chrono::milliseconds(ms));
        if (cb) (cb->*fn)();
    }).detach();
}

extern "C" {
bool Init(CrInt32u) { return true; }
bool Release() { return true; }
CrError EnumCameraObjects(ICrEnumCameraObjectInfo** pp, CrInt8u)
{
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    *pp = new MockEnum();
    return CrError_None;
}
CrError CreateCameraObjectInfoEthernetConnection(ICrCameraObjectInfo** pp, CrCameraDeviceModelList, CrInt32u ip, CrInt8u*, CrInt32u)
{
    auto* i = new MockInfo();
    i->ip = std::to_string(ip & 255) + "." + std::to_string((ip >> 8) & 255) + "." + std::to_string((ip >> 16) & 255) + "." + std::to_string(ip >> 24);
    *pp = i;
    return CrError_None;
}
CrError GetFingerprint(ICrCameraObjectInfo*, char* fp, CrInt32u* size)
{
    strcpy(fp, "MOCKFINGERPRINT=");
    *size = 16;
    return CrError_None;
}
CrError Connect(ICrCameraObjectInfo*, IDeviceCallback* callback, CrDeviceHandle* h, CrSdkControlMode, CrReconnectingSet,
                const char*, const char* pass, const char*, CrInt32u, const CrInt16u*)
{
    {
        std::lock_guard<std::mutex> lock(mx);
        fill();
        cb = callback;
    }
    *h = 1;
    static int busyTries = 0;
    if (pass && std::string(pass) == "busy" && busyTries++ == 0) {
        std::thread([callback] { std::this_thread::sleep_for(std::chrono::milliseconds(400)); callback->OnError(CrWarning_Connect_Already); }).detach();
        return CrError_None;
    }
    if (pass && std::string(pass) == "wrong") {
        std::thread([callback] { std::this_thread::sleep_for(std::chrono::milliseconds(400)); callback->OnError(CrError_Connect_SSH_UserAuthenticationFailed); }).detach();
        return CrError_None;
    }
    std::thread([callback] { std::this_thread::sleep_for(std::chrono::milliseconds(400)); callback->OnConnected(DeviceConnectionVersioin{}); }).detach();
    return CrError_None;
}
CrError Disconnect(CrDeviceHandle) { std::lock_guard<std::mutex> lock(mx); cb = nullptr; return CrError_None; }
CrError ReleaseDevice(CrDeviceHandle) { return CrError_None; }
CrError GetSelectDeviceProperties(CrDeviceHandle, CrInt32u n, CrInt32u* codes, CrDeviceProperty** props, CrInt32* num)
{
    std::lock_guard<std::mutex> lock(mx);
    std::vector<const Stored*> found;
    for (CrInt32u i = 0; i < n; i++) {
        auto it = store.find(codes[i]);
        if (it != store.end()) found.push_back(&it->second);
    }
    *num = (CrInt32)found.size();
    // one block of CrProp like the real SDK; each entry's value list is a separate allocation
    CrProp* arr = new CrProp[found.size() + 1]();
    for (size_t i = 0; i < found.size(); i++) {
        CrProp* one = copyOut(*found[i]);
        arr[i] = *one;
        delete one;
    }
    arr[found.size()].code = 0xFFFFFFFF; // end marker for release
    *props = asSdk(arr);
    return CrError_None;
}
CrError ReleaseDeviceProperties(CrDeviceHandle, CrDeviceProperty* p)
{
    CrProp* arr = reinterpret_cast<CrProp*>(p);
    for (CrProp* x = arr; x->code != 0xFFFFFFFF; x++) delete[] x->values;
    delete[] arr;
    return CrError_None;
}
CrError SetDeviceProperty(CrDeviceHandle, CrDeviceProperty* sp)
{
    const CrProp* p = asProps(sp);
    {
        std::lock_guard<std::mutex> lock(mx);
        if (p->code == CrDeviceProperty_Focus_Operation) return CrError_None;
        auto it = store.find(p->code);
        if (it == store.end()) return CrError_Api_InvalidCalled;
        it->second.p.currentValue = p->currentValue;
    }
    later(150, &IDeviceCallback::OnPropertyChanged);
    return CrError_None;
}
CrError SendCommand(CrDeviceHandle, CrInt32u id, CrCommandParam param)
{
    if (id == CrCommandId_MovieRecord && param == CrCommandParam_Down) {
        std::lock_guard<std::mutex> lock(mx);
        auto& p = store[CrDeviceProperty_RecordingState].p;
        p.currentValue = p.currentValue ? 0 : 1;
    }
    later(200, &IDeviceCallback::OnPropertyChanged);
    return CrError_None;
}
}
} // namespace SCRSDK
