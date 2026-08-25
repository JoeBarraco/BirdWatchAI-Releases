import os, sys
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__))
OLD = r'C:\Users\jbarraco\Downloads\AI render of bird feeder.png'

a = Image.open(OLD).convert('RGB').resize((512, 512), Image.LANCZOS)
b = Image.open(sys.argv[1]).convert('RGB').resize((512, 512), Image.LANCZOS)
s = Image.new('RGB', (1030, 542), (24, 24, 26))
s.paste(a, (3, 27)); s.paste(b, (519, 27))
d = ImageDraw.Draw(s)
d.text((8, 8), 'BEFORE  - AI render of bird feeder.png', fill=(230, 200, 90))
d.text((524, 8), 'AFTER  - rendered from the R05 STL, camera fitted', fill=(140, 230, 150))
s.save(os.path.join(HERE, 'before-after.png'))
print('wrote before-after.png')
