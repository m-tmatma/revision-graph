# VSCode拡張「Git Revision Graph」設計

## Context

TortoiseGitの「リビジョングラフ」は、リポジトリ全体のコミットDAGをブランチ/タグ/マージを含めて視覚化する機能。現状の実装(`src/TortoiseProc/RevisionGraph/*`)を調査した結果、以下が判明している:

- データ取得: 組み込みlibgitで`git log`相当のwalkを実行し、hash/parent/ref情報を収集
- レイアウト: 独自アルゴリズムではなく**OGDFのSugiyamaフレームワーク**(ランク付け→交差最小化→座標確定)に委譲
- 圧縮: refを持たない「親1・子1」の直線区間を間引く(splice)
- 描画: GDI+/SVG/Graphviz共通の描画パスで、ノードは角丸矩形+ref種別ごとの固定色、エッジはポリライン
- 非同期: git log取得〜DAG構築〜レイアウトをワーカースレッドで実行しUIをブロックしない

この知見を踏まえ、同等機能をTypeScript/VSCode拡張として新規に設計する。ユーザーの意向により、スコープは**フル機能パリティ**、データ取得は**git CLIの直接シェルアウト**、描画は**SVGベース**とする。新規プロジェクトとして独立フォルダに作成する(TortoiseGitのリポジトリとは別管理)。

## ゴール /非ゴール

**含める(フルパリティ相当)**
- 全ブランチ/ローカルブランチのみ/現在ブランチのみ/From-Toレンジ、のフィルタ切り替え
- ブランチ・タグ・remote・stashのref表示、ref種別ごとの色分け
- 直線区間の間引き(トグル)、全タグ表示トグル
- ズーム/パン、ミニマップ
- ノード選択(2点選択で比較)、右クリックメニュー(ブランチ切替/削除、コミット比較、hashコピー等)
- SVG/PNGエクスポート

**含めない(将来検討)**
- SVN由来のコピー/リネーム追跡(TortoiseGit側でも現在は死んでいる機能)
- 展開/折りたたみの手動グリフ操作(TortoiseGit側でも未実装)
- date/author/pathによる詳細フィルタ(Logビュー相当は別スコープ)

## アーキテクチャ概要

VSCode拡張は「Extension Host(Node.js)」と「Webview(ブラウザコンテキスト)」に分離する。役割分担:

```
Extension Host                          Webview (SVG UI)
───────────────                         ─────────────────
CLI経由でgit log取得                     postMessage で
  ↓                                      GraphData を受信
生パース → GraphCommit[]                    ↓
  ↓                                      Web Worker内でELKレイアウト計算
DAG構築 + 直線区間の間引き                    ↓
  ↓                                      SVG描画(ノード/エッジ/ラベル)
postMessage で GraphData 送信              ↓
  ↑                                      ユーザー操作(選択/右クリック等)
git操作コマンド実行                        ↑
  (checkout/branch削除等)                postMessage でアクション要求
```

**設計判断の理由**:
- git log取得とDAG構築(TortoiseGitのワーカースレッド相当)はExtension Host側で行う。Extension HostはWebviewとは別プロセスなので、ここで多少重い処理をしてもUIはブロックしない。
- レイアウト計算(Sugiyama相当)はWebview内のWeb Workerで行う。ノード数が数千に達する大規模リポジトリでも描画スレッドをブロックしない。elkjsはWeb Worker実行をサポートしている。
- 実際のgit変更コマンド(checkout/ブランチ削除など)はWebviewから直接実行できない(Node API不可)ため、必ずExtension Hostに委譲する。

## データモデル (TypeScript)

```typescript
interface GraphCommit {
  hash: string;
  parents: string[];       // 親hashの配列(マージは複数)
  subject: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;      // unix time
  refs: RefInfo[];         // このcommitを指すref
}

interface RefInfo {
  name: string;
  type: 'head' | 'local-branch' | 'remote-branch' | 'tag' | 'stash' | 'other';
}

// DAG構築・間引き後、レイアウト入力として渡す形
interface GraphNode {
  id: string;               // hash
  parents: string[];
  refs: RefInfo[];
  width: number;
  height: number;
}

interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
}

interface LaidOutEdge {
  source: string;
  target: string;
  bendPoints: { x: number; y: number }[];
}
```

TortoiseGitの`CLogCache`(hash→メタデータ)、`MAP_HASH_NAME`(hash→ref配列)に相当する構造を`GraphCommit`にまとめて持たせ、シンプルな配列+Mapで管理する(OGDFのような専用グラフライブラリの内部表現に依存しない)。

## Git データ取得

`git log`を直接シェルアウトする(`child_process.spawn`、Extension Host側)。TortoiseGitのフィルタ条件をそのまま踏襲:

- 全ブランチ: `git log --all --parents --pretty=format:"<hash>\x1f<parents>\x1f<subject>\x1f<author>\x1f<email>\x1f<date>" `
- 現在ブランチのみ: `HEAD`のみ対象
- ローカルブランチのみ: `--branches`
- From-Toレンジ: `git log <to> ^<from> --parents ...`
- ref情報は`git for-each-ref --format="%(objectname) %(refname)"`で別途取得し、hashごとにマージ

区切り文字は`\x1f`(Unit Separator、フィールド区切り)を使い、subjectに含まれる可能性のある文字と衝突しないようにする。当初はstdoutをストリームで受け取り行単位でパースする設計だったが(大規模リポジトリでの一括バッファ確保を避ける狙い)、ツールチップ用にコミット本文全体(`%B`)を取得するようになったため、本文に改行が含まれ得る以上「1行=1コミット」というパース方式が成立しなくなった。そのためレコード区切りとして`\x1e`(Record Separator)を各コミットの末尾に付与し、`git log`の出力全体をバッファしてから`\x1e`で分割する方式に変更した(`for-each-ref`/`rev-parse`/`symbolic-ref`など複数行値を持たない呼び出しは引き続き行ストリーミング)。大規模リポジトリでのメモリ使用量が問題になった場合は再検討する。

## DAG構築 と 直線区間の間引き

TortoiseGitの`RevisionGraphDlgFunc.cpp`のロジックをそのまま移植する:

1. `childMap: Map<hash, hash[]>` を構築(parentsの逆引き)
2. 各commitについて、refを持つ、または親/子が0または2以上ある場合は保持
3. 親1・子1の中間commitは、子のparent配列を書き換えて直結し、`skipSet`に追加
4. `skipSet`のcommitを最終的な`GraphNode[]`から除外

「全タグ表示」「直線区間を間引く」はそれぞれトグルとして提供し、オフの場合はステップ2/3をスキップする。

## レイアウトアルゴリズム

**dagre**(`@dagrejs/dagre`、MITライセンス)を採用する。

当初はTortoiseGitのOGDF `OptimalRanking`→`MedianHeuristic`→`FastHierarchyLayout`パイプラインに最も近い**elkjs**(`elk.layered`)を検討したが、elkjsはEPL-2.0ライセンスであり、GPLv2の本プロジェクト([LICENSE](./LICENSE)参照)とはFSFが非互換と明記する組み合わせになる。elkjs側でGPLをSecondary Licenseとして許可する通知(EPL-2.0 Exhibit A)も付与されていないため採用を見送った(詳細は[CLAUDE.md](../CLAUDE.md)のライセンス方針)。dagreも同じ「ランク付け→順序付け→座標確定」という層状(Sugiyama系)レイアウトのパイプラインを持ち、MITライセンスでGPLv2と完全互換のため、これに切り替えた。

Web Worker内で実行し、`postMessage`でメインスレッドに結果(`LaidOutNode[]`, `LaidOutEdge[]`)を返す。ノードサイズは事前にラベル数(ref数)から算出し、dagreに固定サイズとして渡す(TortoiseGitの`SetNodeRect`と同じ考え方)。dagreの`layout()`は同期実行だが、Worker内で行うためメインスレッド(描画/操作)はブロックされない。

## 描画 (SVG)

- ノード: 角丸`<rect>` + 内部に `refs` を縦積みで`<text>`ラベル表示。色は**ref種別ごとの固定パレット**(current branch / local branch / remote branch / tag / stash / other)で、TortoiseGit本家のデフォルト値(`src/TortoiseProc/Colors.cpp`のレジストリデフォルト、`CurrentBranch`=`#c80000`、`LocalBranch`=`#00c300`、`RemoteBranch`=`#ffddaa`、`Tag`=`#ffff00`、`Stash`=`#808080`、`OtherRef`=`#e0e0e0`)にそのまま合わせている(VSCodeテーマには追従しない — テーマが変わっても見た目が本家と一致することを優先)。テキスト色はコントラスト比から自動選択(WCAG相対輝度計算)。
- エッジ: `<polyline>` でelkjsの`bendPoints`をそのまま繋ぐ。ノード境界でクリップ(TortoiseGitの`cutPoint`相当の矩形交差計算)。矢印は`<polygon>`で手計算。
- VSCodeのテーマ変数(`--vscode-editor-background`等)をCSSカスタムプロパティ経由で使い、ライト/ダークテーマに自動追従させる。
- SVG/PNGエクスポート: 描画済みの`<svg>`を`cloneNode`し、`width`/`height`/`viewBox`をグラフ全体の論理サイズに上書きしてシリアライズする(表示中の`viewBox`はパン/ズーム後の一部領域のため)。SVGはそのままファイル書き出し、PNGはさらに`data:image/svg+xml`の`<img>`として読み込み`<canvas>`に描画してから`toDataURL('image/png')`で書き出す。テーマ変数は独立したドキュメントコンテキストの`<img>`内では解決できないため、各属性に埋め込んだフォールバック色(`var(--vscode-x, <fallback>)`)がそのまま使われる — テーマには追従しないが表示は崩れない、という妥協。**大規模リポジトリでは論理サイズがブラウザの2D canvas上限(1辺16384px/総面積約2億6千万px、実測で`5051 x 112174`のような値になるケースを確認)を超えることがあり、その場合`canvas.toDataURL()`は例外を投げず`"data:,"`という無効な値を静かに返す**。これを書き出すと壊れたPNGファイルになるため、`exportPng`側で事前にサイズ判定し、上限超過時はSVGエクスポートを案内するエラーメッセージを表示する。

## インタラクション

- ズーム/パン: SVGの`viewBox`操作 + pointer events(ライブラリ非依存で実装。必要なら`d3-zoom`のみ導入)
- 現在ブランチ(HEAD)への自動スクロール: 初期表示時・フィルタ変更後の再描画時に、`refs`に`head`タイプを持つノードへ確実にスクロールし、大きいグラフでもHEADを探す手間なく見つけられるようにする
- 選択: クリックで1点目選択、Ctrl+クリックで2点目選択(比較用)。選択状態はWebview内のstateで管理。ネイティブの`click`イベントには頼らず、pointerdown/pointerupの座標差が4px未満の場合のみ「クリック」として扱う(パン操作のドラッグと区別するため)。
- ツールチップ: ノードの`<g>`の最初の子としてネイティブ`<title>`要素を追加し、ブラウザ標準のホバー表示に任せる(追加のJS/CSS不要)。内容はTortoiseGit本家のツールチップに合わせ、フルハッシュ→`{author} <{email}> {date}`(`YYYY-MM-DD HH:mm`)→空行→コミットメッセージ全文(subjectだけでなくbody込み)の順。
- 右クリックメニュー: VSCodeのwebview内では独自HTML/CSSでコンテキストメニューを実装(ネイティブメニューAPIはwebview内で使えないため)。メニュー項目(ブランチチェックアウト、ref削除、hashコピー、比較)はExtension Hostにアクション名+hashをpostMessageし、Extension Host側でVSCode Git拡張のAPIまたはgit CLIで実行。
  - 「比較」はTortoiseGitの「変更を比較」ダイアログに近いものを求められたため、単純な`git diff`テキスト表示ではなく、2つ目の独立した`WebviewPanel`(`ViewColumn.Beside`)を開き、ファイルごとの追加/削除行数一覧を表示する。行をクリックするとVSCodeネイティブの差分ビュー(`vscode.diff`)でそのファイルの差分を開く(各revisionでのファイル内容は`revision-graph-git://<rev>/<path>`スキームの`TextDocumentContentProvider`が`git show`経由で提供)。VSCode拡張には別OSウィンドウを直接起動するAPIがないため、「別ウィンドウ」はユーザーがタブをドラッグして切り離す形になる。
  - 「チェックアウト」も同様にTortoiseGitの「切り替え/チェックアウト」ダイアログに近いものを求められ、3つ目の独立した`WebviewPanel`として実装した。ただしTortoiseGitの汎用ダイアログと違い、切り替え先は右クリックしたノードの時点で確定しているため、ブランチ/タグ/コミットを選ぶピッカーは持たない。「オプション」部分(新しいブランチを作成/追跡/既存ブランチの上書き/force/merge/submodule更新)のみ再現している。成功後は自分自身が行ったチェックアウトなので、外部変更の自動検知(M4)を待たず、その場でメイングラフパネルを再取得(`refresh()`)して現在ブランチのハイライトを更新する。
  - 「ref削除」は他の項目と違い破壊的操作のため、実行前にVSCodeネイティブのモーダル確認ダイアログを必ず挟む。削除の意味はref種別ごとに決めている: ローカルブランチは`git branch -d`(安全削除)、タグは`git tag -d`、リモート追跡ブランチ(`origin/foo`等)は**ローカルの追跡refのみ**`git update-ref -d`で削除し、実際のリモートサーバー上のブランチには一切触れない — 他人と共有するサーバーの状態を変更するのは右クリック一発の操作としてはスコープ外、という判断をユーザーに確認した上で採用。「ref名をコピー」はノード内の全refをまとめてコピーする仕様(ref単位でクリックし分ける必要がない)にした一方、「ref削除」は削除対象を一意にする必要があるため、右クリックした特定のrefチップにのみ表示する(ノード全体ではなく、rowごとに`data-ref-name`/`data-ref-type`を持たせて判定)。
- ミニマップ: パネル右下に、グラフ全体を縮小した別SVG(ノードは無地の矩形のみ、ref/テキスト/ツールチップなし)をオーバーレイ表示し、現在の表示領域を示す矩形を重ねる。矩形に限らずミニマップ上のどこをドラッグ/クリックしても、その位置へメイン表示がパン移動する(ズーム倍率は維持)。枠のサイズはグラフの縦横比を保ったまま、パネル自体のサイズに応じた上限内に収める — 実際のリポジトリで検証した結果、コミット履歴は横に比べて縦に大きく伸びる(時に`5051 x 112174`のような極端な比率になる)ため、縦横比を厳密に保つと枠内のほとんどが空白になり、内容が数pxの線に潰れて見えなくなる問題があった。かといって縦横比を無視して枠いっぱいに引き伸ばすと、普通の比率のリポジトリでは逆に不自然に横長になる。最終的に「縦横比は保ちつつ、幅の下限(`MIN_WIDTH`)を設ける」形で決着した — 下限に達したときだけ意図的に余白ができる。
- インクリメンタルチェックアウト(M4完了後に追加): ツールバーの「Checkout…」ボタンから、VSCode標準の`showQuickPick`でローカル/リモートブランチ一覧を表示する。入力するたびに絞り込み、上下キーで移動、Enterで確定してチェックアウトする挙動はQuickPick標準機能そのままで、独自UIは実装していない。右クリックの「チェックアウト」(既存ノード基準・オプション豊富)とは役割を分け、こちらはオプションなしの単純な`git checkout <target>`専用。リモートブランチはフル名(`origin/foo`)ではなくリモートprefixを外した短い名前をターゲットにする — フル名を直接チェックアウトするとdetached HEADになってしまうため、短い名前でgitの「DWIM」(ローカル追跡ブランチの自動作成/再利用)を発動させる。

## VSCode統合ポイント

- `package.json`の`contributes.commands`に`gitRevisionGraph.show`を追加し、コマンドパレット/SCMビューのタイトルアイコンから起動
- `vscode.window.createWebviewPanel`で表示、`retainContextWhenHidden: true`でタブ切り替え時も状態保持
- Content Security Policyを`nonce`ベースで設定し、インラインスクリプトを許可
- リポジトリ変更検知: `vscode.git`拡張のExtension APIから`Repository.state.onDidChange`を購読し、`.git/refs`やHEAD変更時に自動リフレッシュ(またはユーザーが手動リフレッシュボタン)。`state.onDidChange`はref/HEAD以外(ワークツリーの変更等)でも発火し、1回の操作で連続発火することもあるため500msデバウンスしてから再取得する。対象リポジトリは`git.onDidOpenRepository`も購読して後から見つかるケースに対応する。
- マルチルートワークスペース対応: アクティブなリポジトリをVSCode Git拡張のAPIから取得

## プロジェクト構成(新規フォルダ: D:\gitwork\revision-graph)

実装開始時に`D:\gitwork\revision-graph`を作成し、`git init`で新規リポジトリとして初期化する(TortoiseGit本体のリポジトリとは完全に独立)。

```
revision-graph/
  package.json
  tsconfig.json
  esbuild.js                 # VSCode拡張標準のesbuildバンドル構成
  src/
    extension.ts              # activate/コマンド登録
    git/
      logReader.ts            # git log/for-each-ref シェルアウト+パース
      dagReducer.ts            # 直線区間の間引きロジック
      gitActions.ts            # checkout/削除等のgit操作
    webview/
      main.ts                  # Webviewエントリ、postMessage受信
      layoutWorker.ts          # elkjs実行用Web Worker
      render/
        graphRenderer.ts        # SVG描画
        colors.ts                # ref種別カラーパレット、コントラスト計算
        panZoom.ts               # ズーム/パン
        contextMenu.ts           # 右クリックメニュー
      panel.html
  test/
    dagReducer.test.ts         # 間引きロジックの単体テスト(合成コミット列で検証)
    logReader.test.ts          # git logパースの単体テスト
```

パッケージマネージャはnpm、ビルドはesbuild(VSCode公式サンプルの標準構成)、言語はTypeScript。

## マイルストーン

1. **M1 コア表示**: git log取得→DAG構築→dagreレイアウト→SVG静的描画(ズーム/パンなし)
2. **M2 フィルタ/間引き**: フィルタUI(全ブランチ/ローカル/現在/From-To)、直線区間間引き、全タグ表示トグル。「ダイアログ」ではなく、Webview上部に常設するツールバー(select+チェックボックス+Refreshボタン)として実装した — TortoiseGitのモーダルダイアログと違い、値を変えるたびに即座に再取得・再描画する方が、都度ダイアログを開き直すよりWebviewの操作感に合う
3. **M3 インタラクション**: ズーム/パン、ノード選択+比較、右クリックメニュー、ツールチップ
4. **M4 仕上げ**: ミニマップ、SVG/PNGエクスポート、リポジトリ変更の自動検知・リフレッシュ

## 検証方法

- `dagReducer.ts`と`logReader.ts`は合成データ(架空のhash/parent列)でユニットテスト
- 実際の検証は`git-revision-graph`拡張を`F5`でExtension Development Hostとして起動し、実リポジトリ(まずはこのtortoisegitリポジトリ自体でもよい)に対してコマンドを実行し、目視でグラフ描画・フィルタ・ズーム/パン・右クリックメニューの動作を確認する
- 大規模リポジトリ(数千コミット)でのレイアウト計算時間・描画のレスポンスを計測する。TortoiseGit自体のリポジトリ(全ブランチで12,000コミット超、間引き後1,000ノード超)で実測したところ、dagreのランク付けパス(再帰DFS)がWeb Workerの狭いスタックでオーバーフローする問題が見つかった(`RangeError: Maximum call stack size exceeded`)。メインスレッド(スタックが大きい)へのフォールバックで解消している(`webview/main.ts`)

## 未決事項(実装開始前に確認)

- 拡張のpublisher名/拡張ID(Marketplace公開の予定有無)
