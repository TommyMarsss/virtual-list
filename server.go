// 一个最小的本地静态文件服务器，仅用于本地预览虚拟列表演示页面。
// 用法：  go run server.go          （默认 :8080）
//        go run server.go -addr :9000
// 也可以直接双击 index.html 用 file:// 打开，不依赖本服务。
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
)

func main() {
	addr := flag.String("addr", ":8080", "监听地址")
	flag.Parse()

	dir, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stat("index.html"); err != nil {
		log.Printf("警告：当前目录 %s 下没有 index.html", dir)
	}

	fs := http.FileServer(http.Dir(dir))
	http.Handle("/", noCache(fs))

	log.Printf("虚拟列表演示页： http://localhost%s/index.html", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

// noCache 关闭缓存，方便本地修改 js/html 后刷新即生效
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, max-age=0")
		h.ServeHTTP(w, r)
	})
}
