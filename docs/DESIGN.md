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

区切り文字は`\x1f`(Unit Separator)を使い、subjectに含まれる可能性のある文字と衝突しないようにする。stdoutをストリームで受け取り行単位でパースする(大規模リポジトリでの一括バッファ確保を避ける)。

## DAG構築 と 直線区間の間引き

TortoiseGitの`RevisionGraphDlgFunc.cpp`のロジックをそのまま移植する:

1. `childMap: Map<hash, hash[]>` を構築(parentsの逆引き)
2. 各commitについて、refを持つ、または親/子が0または2以上ある場合は保持
3. 親1・子1の中間commitは、子のparent配列を書き換えて直結し、`skipSet`に追加
4. `skipSet`のcommitを最終的な`GraphNode[]`から除外

「全タグ表示」「直線区間を間引く」はそれぞれトグルとして提供し、オフの場合はステップ2/3をスキップする。

## レイアウトアルゴリズム

**elkjs**(Eclipse Layout Kernel のJS版)の`elk.layered`アルゴリズムを採用する。

理由: TortoiseGitはOGDFの`OptimalRanking`(ランク付け)→`MedianHeuristic`(交差最小化)→`FastHierarchyLayout`(座標確定)という層状グラフレイアウトを使っている。elkjsの`layered`アルゴリズムは同じ3段階構成(`nodePlacement`, `crossingMinimization`, `cycleBreaking`など)をオプションで持ち、概念的に最も近い。dagreはより軽量だが層状レイアウトの調整幅が狭く、複雑なマージ構造での見た目の品質がelkjsに劣る場合がある。まずelkjsで実装し、大規模リポジトリでパフォーマンス上の問題が出た場合にdagreへのフォールバックを検討する。

Web Worker内で実行し、`postMessage`でメインスレッドに結果(`LaidOutNode[]`, `LaidOutEdge[]`)を返す。ノードサイズは事前にラベル数(ref数)から算出し、elkjsに固定サイズとして渡す(TortoiseGitの`SetNodeRect`と同じ考え方)。

## 描画 (SVG)

- ノード: 角丸`<rect>` + 内部に `refs` を縦積みで`<text>`ラベル表示。色はTortoiseGitに倣い**ref種別ごとの固定パレット**(current branch / local branch / remote branch / tag / stash / other)。テキスト色はコントラスト比から自動選択(WCAG相対輝度計算)。
- エッジ: `<polyline>` でelkjsの`bendPoints`をそのまま繋ぐ。ノード境界でクリップ(TortoiseGitの`cutPoint`相当の矩形交差計算)。矢印は`<polygon>`で手計算。
- VSCodeのテーマ変数(`--vscode-editor-background`等)をCSSカスタムプロパティ経由で使い、ライト/ダークテーマに自動追従させる。

## インタラクション

- ズーム/パン: SVGの`viewBox`操作 + pointer events(ライブラリ非依存で実装。必要なら`d3-zoom`のみ導入)
- 選択: クリックで1点目選択、Ctrl+クリックで2点目選択(比較用)。選択状態はWebview内のstateで管理。
- ツールチップ: ネイティブ`<title>`要素、またはホバー時にカスタムHTMLオーバーレイ(author/date/subjectをリッチ表示)
- 右クリックメニュー: VSCodeのwebview内では独自HTML/CSSでコンテキストメニューを実装(ネイティブメニューAPIはwebview内で使えないため)。メニュー項目(ブランチチェックアウト、ref削除、hashコピー、比較)はExtension Hostにアクション名+hashをpostMessageし、Extension Host側でVSCode Git拡張のAPIまたはgit CLIで実行。
- ミニマップ: 縮小した別SVGをオーバーレイ表示し、ビューポート矩形をドラッグ可能にする。

## VSCode統合ポイント

- `package.json`の`contributes.commands`に`gitRevisionGraph.show`を追加し、コマンドパレット/SCMビューのタイトルアイコンから起動
- `vscode.window.createWebviewPanel`で表示、`retainContextWhenHidden: true`でタブ切り替え時も状態保持
- Content Security Policyを`nonce`ベースで設定し、インラインスクリプトを許可
- リポジトリ変更検知: `vscode.git`拡張のExtension APIから`Repository.state.onDidChange`を購読し、`.git/refs`やHEAD変更時に自動リフレッシュ(またはユーザーが手動リフレッシュボタン)
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

1. **M1 コア表示**: git log取得→DAG構築→elkjsレイアウト→SVG静的描画(ズーム/パンなし)
2. **M2 フィルタ/間引き**: フィルタダイアログ(全ブランチ/ローカル/現在/From-To)、直線区間間引き、全タグ表示トグル
3. **M3 インタラクション**: ズーム/パン、ノード選択+比較、右クリックメニュー、ツールチップ
4. **M4 仕上げ**: ミニマップ、SVG/PNGエクスポート、リポジトリ変更の自動検知・リフレッシュ

## 検証方法

- `dagReducer.ts`と`logReader.ts`は合成データ(架空のhash/parent列)でユニットテスト
- 実際の検証は`git-revision-graph`拡張を`F5`でExtension Development Hostとして起動し、実リポジトリ(まずはこのtortoisegitリポジトリ自体でもよい)に対してコマンドを実行し、目視でグラフ描画・フィルタ・ズーム/パン・右クリックメニューの動作を確認する
- 大規模リポジトリ(数千コミット)でのレイアウト計算時間・描画のレスポンスを計測し、必要ならelkjs設定のチューニングやdagreへの切り替えを検討

## 未決事項(実装開始前に確認)

- 拡張のpublisher名/拡張ID(Marketplace公開の予定有無)
