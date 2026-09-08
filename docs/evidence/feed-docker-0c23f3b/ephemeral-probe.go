package main
import("os")
func main(){
 if len(os.Args)!=2 {os.Exit(2)}
 switch os.Args[1] {
 case "write": if os.WriteFile("/tmp/marker",[]byte("ephemeral probe"),0600)!=nil {os.Exit(3)}
 case "present": if _,e:=os.Stat("/tmp/marker");e!=nil {os.Exit(4)}
 case "absent": if _,e:=os.Stat("/tmp/marker");!os.IsNotExist(e) {os.Exit(5)}
 default: os.Exit(6)
 }
}
