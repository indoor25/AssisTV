# Third-party code in `libs/`

These files are bundled as is so the TV does not depend on a CDN at run time.

## mqtt.min.js — MQTT.js 5.15.2

https://github.com/mqttjs/MQTT.js — browser build (`dist/mqtt.min.js`).

```
The MIT License (MIT)
=====================

Copyright (c) 2015-2016 MQTT.js contributors
---------------------------------------

*MQTT.js contributors listed at <https://github.com/mqttjs/MQTT.js#contributors>*

Copyright 2011-2014 by Adam Rudd

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The add-on installs its Node.js dependencies (`ws`, `mqtt`, `mqtt-packet`) from npm with their own licences;
the `-Legacy` build pulls Babel, core-js and regenerator from npm the same way. None of them are stored here.
