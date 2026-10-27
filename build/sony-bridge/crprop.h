// Plain-struct view of SCRSDK::CrDeviceProperty.
// The SDK's CrDeviceProperty methods are C++ exports from Cr_Core.dll, which only an MSVC build can call.
// Reading and filling the struct directly works with any compiler (MinGW included), because the
// class is just these fields (see the private section of CrDeviceProperty in CrDeviceProperty.h).
#pragma once
#include <cstddef>
#include "CrDeviceProperty.h"

struct CrProp {
    CrInt32u code;
    SCRSDK::CrDataType valueType;
    SCRSDK::CrPropertyEnableFlag enableFlag;
    SCRSDK::CrPropertyVariableFlag variableFlag;
    CrInt64u currentValue;
    CrInt16u* currentStr;
    CrInt32u valuesSize;
    CrInt8u* values;
    CrInt32u getSetValuesSize;
    CrInt8u* getSetValues;
};
static_assert(sizeof(CrProp) == sizeof(SCRSDK::CrDeviceProperty), "CrProp must match CrDeviceProperty");
static_assert(offsetof(CrProp, currentValue) == 16 && offsetof(CrProp, values) == 40, "unexpected CrDeviceProperty layout");

inline const CrProp* asProps(const SCRSDK::CrDeviceProperty* p) { return reinterpret_cast<const CrProp*>(p); }
inline SCRSDK::CrDeviceProperty* asSdk(CrProp* p) { return reinterpret_cast<SCRSDK::CrDeviceProperty*>(p); }
inline bool propWritable(const CrProp& p)
{
    return p.enableFlag == SCRSDK::CrEnableValue_True || p.enableFlag == SCRSDK::CrEnableValue_SetOnly;
}

// Plain-struct views of SCRSDK::CrImageInfo and SCRSDK::CrImageDataBlock (live view), for the same reason.
struct CrLiveViewInfo {
    CrInt32u width;
    CrInt32u height;
    CrInt32u bufferSize;
};
struct CrLiveViewBlock {
    CrInt32u frameNo;
    CrInt32u size;
    CrInt8u* pData;
    CrInt32u imageSize;
    CrInt32u timeCode;
};
#include "CrImageDataBlock.h"
static_assert(sizeof(CrLiveViewInfo) == sizeof(SCRSDK::CrImageInfo), "CrLiveViewInfo must match CrImageInfo");
static_assert(sizeof(CrLiveViewBlock) == sizeof(SCRSDK::CrImageDataBlock), "CrLiveViewBlock must match CrImageDataBlock");
