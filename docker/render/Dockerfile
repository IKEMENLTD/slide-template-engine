# 描画専用の小さいイメージ（14-1）。LibreOffice＋リポジトリの fonts/＋pdftoppm だけ。
# 日本語フォントはパッケージの Noto CJK を入れず、fonts/ の静的フォントだけを入れる。
# ＝テンプレートが指定したフォントが無いと代替（DejaVu）で描かれ、すぐ気づける。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-impress-nogui poppler-utils fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY fonts/ /usr/share/fonts/slidegen/
RUN fc-cache -f && fc-list : family style | sort > /fonts.txt
WORKDIR /work
