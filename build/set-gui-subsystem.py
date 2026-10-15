# Marks a Windows .exe as a GUI app so no console window opens.
import struct, sys
p = sys.argv[1]
d = bytearray(open(p, 'rb').read())
pe = struct.unpack_from('<I', d, 0x3C)[0]
assert d[pe:pe + 4] == b'PE\0\0'
off = pe + 24 + 68
print('subsystem was', struct.unpack_from('<H', d, off)[0])
struct.pack_into('<H', d, off, 2)
open(p, 'wb').write(d)
