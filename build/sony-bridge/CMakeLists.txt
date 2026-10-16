cmake_minimum_required(VERSION 3.16)
project(sony_bridge LANGUAGES CXX)

# Point SONY_SDK at the unzipped Sony Camera Remote SDK (the folder that has app/CRSDK and external/crsdk).
set(SONY_SDK "${CMAKE_CURRENT_SOURCE_DIR}/sdk" CACHE PATH "Sony Camera Remote SDK folder")

if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()

add_executable(sony-bridge sony_bridge.cpp)
set_target_properties(sony-bridge PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED YES)
target_include_directories(sony-bridge PRIVATE "${SONY_SDK}/app/CRSDK")
if(WIN32)
    target_compile_definitions(sony-bridge PRIVATE UNICODE _UNICODE NOMINMAX)
endif()

find_library(CR_CORE Cr_Core HINTS "${SONY_SDK}/external/crsdk" REQUIRED)
target_link_libraries(sony-bridge PRIVATE ${CR_CORE})

# Cr_Core.dll, the CrAdapter folder and the monitor DLLs must sit next to sony-bridge.exe
add_custom_command(TARGET sony-bridge POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${SONY_SDK}/external/crsdk" $<TARGET_FILE_DIR:sony-bridge>)
