# カード画像の追加方法

画像がなくても文字表示で動作します。差し替える場合は、透過PNGを次の名前で配置してください。

- `goma/goma_1.png` 〜 `goma/goma_4.png`
- `rei/rei_1.png` 〜 `rei/rei_4.png`
- `guri/guri_1.png` 〜 `guri/guri_4.png`
- `chopa/chopa_1.png` 〜 `chopa/chopa_4.png`
- `hagechopa/hagechopa_joker.png`
- `card_back.png`（全カード共通の裏面）

表面画像が読み込めた場合はカード全面に自動表示され、画像がない場合はキャラクター名・マーク・番号を表示します。裏面画像がない場合はピンクの標準デザインを表示します。縦横比の異なる画像も `object-fit` でカード内に収まります。
