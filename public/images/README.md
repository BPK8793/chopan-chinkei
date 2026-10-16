# カード画像の追加方法

画像がなくても文字表示で動作します。差し替える場合は、透過PNGを次の名前で配置してください。

- `goma/goma_1.png` 〜 `goma/goma_4.png`
- `rei/rei_1.png` 〜 `rei/rei_4.png`
- `guri/guri_1.png` 〜 `guri/guri_4.png`
- `chopa/chopa_1.png` 〜 `chopa/chopa_4.png`
- `hagechopa/hagechopa_joker.png`
- カード裏面は上下のない回転対称柄をCSSで描画するため、裏面画像は不要です。

表面画像が読み込めた場合は画像を優先し、画像がない場合のみキャラクター名・マーク・番号を文字表示します。キャラクター画像は透過PNGを推奨し、共通UIがキャラクター別のパステル背景、番号、スート、名前札を重ねます。画像は `object-fit: contain` で主要部分を切らずに表示します。裏面は常にピンクの回転対称デザインです。
