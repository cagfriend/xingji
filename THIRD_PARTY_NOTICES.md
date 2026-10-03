# 地图数据来源与许可

本项目随包提供机场坐标，并在运行时按需请求 OpenStreetMap 地图瓦片。以下资料仅供航班可视化，位置可能存在误差。

- OurAirports `airports.csv`：https://ourairports.com/data/ ，Public Domain。
- TMC_Dataset `airport-terminal-cn.json`（仅派生机场名称别名）：https://github.com/Timeon1/TMC_Dataset ，MIT License，Copyright (c) 2024 YanWei。
- Leaflet 1.9.4：https://leafletjs.com/ ，MIT License，Copyright (c) 2010-2023, Vladimir Agafonkin；Copyright (c) 2010-2011, CloudMade。随包提供 `dist/vendor/leaflet.js` 和 `dist/vendor/leaflet.css`。
- 航司标识资源：Soaring Symbols：https://github.com/soaring-symbols/soaring-symbols ，MIT License；Jxck-S/airline-logos：https://github.com/Jxck-S/airline-logos ，其仓库声明标识仅用于航空识别参考。随包 SVG / PNG 仅用于识别参考；航空公司名称及标识的商标权归各权利人所有。
- OpenStreetMap 标准地图瓦片：https://tile.openstreetmap.org/ ，© OpenStreetMap contributors。按 https://operations.osmfoundation.org/policies/tiles/ 从浏览器按需获取，在地图上显示署名；不会批量预下载。

上述 MIT 许可的完整文本：

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
