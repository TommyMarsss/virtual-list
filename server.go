package main

import (
	"fmt"
	"log"
	"net/http"
)

// 本地静态文件服务器,用于预览虚拟列表演示页面。
// 运行: go run server.go  然后访问 http://localhost:8080
// (index.html 无模块加载、无跨域请求,直接双击用 file:// 打开也可以)
func main() {
	addr := ":8080"
	fmt.Println("Serving demo at http://localhost" + addr)
	log.Fatal(http.ListenAndServe(addr, http.FileServer(http.Dir("."))))
}
