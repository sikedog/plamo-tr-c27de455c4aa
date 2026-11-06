# PLaMo翻訳 (offline PWA, prototype)

PLaMo 3 Translate (0.8B, GGUF) をブラウザ内で動かすオフライン翻訳の試作です。
llama.cpp の WebAssembly 版 (wllama) を同梱しています。モデル本体は同梱せず、初回起動時に
Hugging Face から端末へ保存します。

## 公開のしかた (HTTPS が必要)

静的ファイルだけなので、このフォルダをそのまま置けばOKです。

- Cloudflare Pages の Direct Upload (最大ファイルは約16MBで、上限内)
- Netlify Drop (フォルダをドラッグ)
- GitHub Pages

## iPhone で使う

1. Safari で公開URLを開く
2. 共有ボタン -> 「ホーム画面に追加」
3. 「モデルをダウンロード」(Wi-Fi 推奨、約0.5GB)
4. 保存後は機内モードでも動く

## うまくいかないとき

- 画面下の「診断情報」を確認
- 設定で「プロンプト方式」を「チャットテンプレート」に切り替え
- 「モデルのURLを直接指定」に、Hugging Face で確認した .gguf の URL を入れる
- 処理方式は CPU (標準) のまま。WebGPU は実験的

## 構成

- `index.html` / `app.js` : 画面と処理
- `pfml3.js` : PLaMo 3 Translate のプロンプト形式 (PFML3) の組み立て
- `sw.js` : アプリ本体と wllama のオフライン用キャッシュ
- `vendor/` : wllama (MIT) と iOS Safari 向け互換ビルド

## ライセンス

PLaMo 3 Translate は PLaMo Community License です。個人利用は無償。
仕事での利用は商用扱いになり、条件があります (登録、売上10億円以下など)。
wllama は MIT (`vendor/LICENSE-wllama.txt`)。
